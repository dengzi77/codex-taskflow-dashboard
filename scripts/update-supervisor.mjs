#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const repository = "dengzi77/codex-taskflow-dashboard";
const latestCommitUrl = `https://api.github.com/repos/${repository}/commits/main`;
const defaultUpdateIntervalMs = 5 * 60 * 1_000;
const initialUpdateDelayMs = 10_000;
const healthTimeoutMs = 15_000;
const updateStateVersion = 1;

function autoUpdateEnabled(env = process.env) {
  return !new Set(["0", "false", "off"]).has(
    String(env.CODEX_TASKBOARD_AUTO_UPDATE ?? "1").trim().toLowerCase(),
  );
}

function updateInterval(env = process.env) {
  const configured = Number(env.CODEX_TASKBOARD_UPDATE_INTERVAL_MS ?? defaultUpdateIntervalMs);
  return Number.isInteger(configured) && configured >= 60_000
    ? configured
    : defaultUpdateIntervalMs;
}

function taskboardPort(env = process.env) {
  const port = Number(env.CODEX_TASKBOARD_PORT ?? 47823);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CODEX_TASKBOARD_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function taskboardDataDirectory(env = process.env) {
  return env.CODEX_TASKBOARD_DATA_DIR
    ? path.resolve(env.CODEX_TASKBOARD_DATA_DIR)
    : path.join(projectRoot, ".data");
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireSupervisorLock(dataDirectory) {
  await mkdir(dataDirectory, { recursive: true });
  const lockPath = path.join(dataDirectory, "update-supervisor.lock");

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      let ownerPid = null;
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8"));
        if (Number.isInteger(owner?.pid) && owner.pid > 0) ownerPid = owner.pid;
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
      }

      if (ownerPid && processIsRunning(ownerPid)) return null;

      const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
      try {
        await rename(lockPath, stalePath);
        await rm(stalePath, { force: true });
      } catch (renameError) {
        if (renameError?.code !== "ENOENT") throw renameError;
      }
    }
  }
}

function isRevision(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function runCommand(command, args, { cwd, stdio = "inherit" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(command)} exited with ${signal ?? code}`));
    });
  });
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function releaseIsReady(releaseRoot) {
  return Promise.all([
    pathExists(path.join(releaseRoot, "server", "index.mjs")),
    pathExists(path.join(releaseRoot, "dist", "web", "index.html")),
    pathExists(path.join(releaseRoot, "node_modules")),
  ]).then((checks) => checks.every(Boolean));
}

async function fetchLatestRevision(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(latestCommitUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "codex-taskflow-dashboard-updater",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub update check returned ${response.status}`);
  }
  const payload = await response.json();
  if (!isRevision(payload?.sha)) throw new Error("GitHub returned an invalid commit revision");
  return payload.sha;
}

async function readUpdateState(statePath, releasesDirectory) {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state?.version !== updateStateVersion || !isRevision(state.activeRevision)) return null;
    const releaseRoot = path.join(releasesDirectory, state.activeRevision);
    return await releaseIsReady(releaseRoot) ? state : null;
  } catch {
    return null;
  }
}

async function writeUpdateState(statePath, revision) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({
    version: updateStateVersion,
    activeRevision: revision,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statePath);
}

async function installRelease(revision, releasesDirectory) {
  if (!isRevision(revision)) throw new Error("Cannot install an invalid update revision");
  const releaseRoot = path.join(releasesDirectory, revision);
  if (await releaseIsReady(releaseRoot)) return releaseRoot;

  const stagingRoot = path.join(
    releasesDirectory,
    `${revision}.partial-${process.pid}-${Date.now().toString(36)}`,
  );
  await rm(releaseRoot, { recursive: true, force: true });
  await rm(stagingRoot, { recursive: true, force: true });
  try {
    console.log(`Downloading Taskboard update ${revision.slice(0, 12)}...`);
    await runCommand(commandName("npx"), [
      "--yes",
      "degit",
      `${repository}#${revision}`,
      stagingRoot,
    ], { cwd: projectRoot });

    const manifest = JSON.parse(await readFile(path.join(stagingRoot, "package.json"), "utf8"));
    if (manifest?.name !== "codex-taskflow-dashboard") {
      throw new Error("Downloaded update is not a Codex Taskboard release");
    }
    await runCommand(commandName("npm"), ["ci", "--no-audit", "--no-fund"], {
      cwd: stagingRoot,
    });
    await runCommand(commandName("npm"), ["run", "build:web"], { cwd: stagingRoot });
    await rename(stagingRoot, releaseRoot);
    return releaseRoot;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function waitForHealth(port, child, timeoutMs = healthTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/health`;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `Taskboard process exited before becoming healthy (${child.signalCode ?? child.exitCode})`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await response.json())?.status === "ok") return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export function createUpdateSupervisor({
  env = process.env,
  fetchRevision = fetchLatestRevision,
  stageRelease = installRelease,
  refreshCodex,
} = {}) {
  const dataDirectory = taskboardDataDirectory(env);
  const releasesDirectory = path.join(dataDirectory, "releases");
  const statePath = path.join(dataDirectory, "runtime-update.json");
  const port = taskboardPort(env);
  let activeRoot = projectRoot;
  let activeRevision = null;
  let serverChild = null;
  let restartTimer = null;
  let updateTimer = null;
  let initialUpdateTimer = null;
  let suppressRestart = false;
  let shuttingDown = false;
  let updateInFlight = null;

  function launchServer(runtimeRoot) {
    const child = spawn(process.execPath, [path.join(runtimeRoot, "server", "index.mjs")], {
      cwd: runtimeRoot,
      env: {
        ...env,
        CODEX_TASKBOARD_DATA_DIR: dataDirectory,
      },
      stdio: "inherit",
    });
    serverChild = child;
    child.once("error", (error) => {
      console.error(`Taskboard process error: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      if (serverChild !== child) return;
      serverChild = null;
      if (shuttingDown || suppressRestart) return;
      console.error(`Taskboard exited (${signal ?? code}); restarting...`);
      restartTimer = setTimeout(() => launchServer(activeRoot), 1_000);
    });
    return child;
  }

  async function stopServer() {
    const child = serverChild;
    if (!child) return;
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    let forceTimer;
    const forceAfterTimeout = new Promise((resolve) => {
      forceTimer = setTimeout(resolve, 10_000);
      forceTimer.unref();
    });
    await Promise.race([exit, forceAfterTimeout]);
    clearTimeout(forceTimer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    if (serverChild === child) serverChild = null;
  }

  async function switchRelease(revision, releaseRoot) {
    const previousRoot = activeRoot;
    suppressRestart = true;
    await stopServer();
    try {
      const nextServer = launchServer(releaseRoot);
      await waitForHealth(port, nextServer);
      await writeUpdateState(statePath, revision);
      activeRoot = releaseRoot;
      activeRevision = revision;
    } catch (error) {
      await stopServer();
      const previousServer = launchServer(previousRoot);
      await waitForHealth(port, previousServer).catch(() => {});
      throw error;
    } finally {
      suppressRestart = false;
    }
  }

  async function defaultRefreshCodex(runtimeRoot) {
    try {
      await runCommand(
        process.execPath,
        [path.join(runtimeRoot, "scripts", "codex-injector.mjs"), "--refresh"],
        { cwd: runtimeRoot, stdio: "ignore" },
      );
    } catch {
      // The standalone web app can update without a debuggable Codex window.
    }
  }

  async function checkForUpdate() {
    if (!autoUpdateEnabled(env) || shuttingDown) return { updated: false, reason: "disabled" };
    if (updateInFlight) return updateInFlight;
    updateInFlight = (async () => {
      const revision = await fetchRevision();
      if (revision === activeRevision) return { updated: false, revision };
      const releaseRoot = await stageRelease(revision, releasesDirectory);
      if (shuttingDown) return { updated: false, reason: "stopping", revision };
      await switchRelease(revision, releaseRoot);
      await (refreshCodex ?? defaultRefreshCodex)(releaseRoot);
      console.log(`Taskboard updated to ${revision.slice(0, 12)}.`);
      return { updated: true, revision, releaseRoot };
    })();
    try {
      return await updateInFlight;
    } finally {
      updateInFlight = null;
    }
  }

  async function start() {
    await mkdir(releasesDirectory, { recursive: true });
    const state = await readUpdateState(statePath, releasesDirectory);
    if (state) {
      activeRevision = state.activeRevision;
      activeRoot = path.join(releasesDirectory, state.activeRevision);
    }
    const initialServer = launchServer(activeRoot);
    try {
      await waitForHealth(port, initialServer);
    } catch (error) {
      suppressRestart = true;
      await stopServer();
      throw error;
    }
    if (autoUpdateEnabled(env)) {
      initialUpdateTimer = setTimeout(() => {
        void checkForUpdate().catch((error) => {
          console.error(`Taskboard update failed: ${error.message}`);
        });
      }, initialUpdateDelayMs);
      updateTimer = setInterval(() => {
        void checkForUpdate().catch((error) => {
          console.error(`Taskboard update failed: ${error.message}`);
        });
      }, updateInterval(env));
      updateTimer.unref();
    }
    return { activeRoot, activeRevision, dataDirectory, port };
  }

  async function stop() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(restartTimer);
    clearTimeout(initialUpdateTimer);
    clearInterval(updateTimer);
    if (updateInFlight) await updateInFlight.catch(() => {});
    suppressRestart = true;
    await stopServer();
  }

  return {
    start,
    stop,
    checkForUpdate,
    getState: () => ({ activeRoot, activeRevision, dataDirectory, port }),
  };
}

async function main() {
  const dataDirectory = taskboardDataDirectory();
  const releaseLock = await acquireSupervisorLock(dataDirectory);
  if (!releaseLock) {
    console.log(`Taskboard supervisor is already running (data: ${dataDirectory}).`);
    return;
  }

  const supervisor = createUpdateSupervisor();
  let state;
  try {
    state = await supervisor.start();
  } catch (error) {
    await releaseLock();
    throw error;
  }
  console.log(
    `Taskboard auto-update is ${autoUpdateEnabled() ? "enabled" : "disabled"} `
    + `(data: ${state.dataDirectory}).`,
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await supervisor.stop();
    await releaseLock();
  };
  process.once("SIGINT", () => stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => stop().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
