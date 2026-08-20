#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const launcherApp = "/Applications/ChatGPT.app";
const officialApp = "/Applications/Codex.app";
const legacyOfficialApp = "/Applications/.ChatGPT Official.app";
const officialBundleId = "com.openai.codex";
const launcherBundleId = "io.github.dengzi77.codex-taskflow-dashboard.launcher";
const compatibleLauncherBundleIds = new Set([
  launcherBundleId,
  "com.dengzi.taskflow-dashboard-launcher",
]);
const launcherExecutable = "taskflow-dashboard-launcher";
const debuggingPort = parseDebuggingPort(process.env.CODEX_TASKFLOW_DEBUG_PORT);
const launchServices = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const plistBuddy = "/usr/libexec/PlistBuddy";
const dockPlist = path.join(homedir(), "Library", "Preferences", "com.apple.dock.plist");
const legacyDockUrl = "file:///Applications/.ChatGPT%20Official.app/";
const officialDockUrl = "file:///Applications/Codex.app/";

function parseArgs(argv) {
  const options = { uninstall: false, launch: false };
  for (const arg of argv) {
    if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--launch") options.launch = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function parseDebuggingPort(value) {
  const port = Number(value ?? 9231);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CODEX_TASKFLOW_DEBUG_PORT must be an integer between 1 and 65535");
  }
  return port;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function readBundleId(appPath) {
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIdentifier", "raw", path.join(appPath, "Contents", "Info.plist")],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launcherPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>ChatGPT</string>
  <key>CFBundleExecutable</key>
  <string>${xmlEscape(launcherExecutable)}</string>
  <key>CFBundleIconFile</key>
  <string>app.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${xmlEscape(launcherBundleId)}</string>
  <key>CFBundleName</key>
  <string>ChatGPT</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function launcherScript() {
  const fallbackInjectorPath = path.join(projectRoot, "scripts", "codex-injector.mjs");
  const logPath = path.join(projectRoot, ".data", "codex-launcher.log");
  return `#!/bin/zsh
set -u

OFFICIAL_APP=${shellQuote(officialApp)}
NODE_BIN=${shellQuote(process.execPath)}
FALLBACK_INJECTOR=${shellQuote(fallbackInjectorPath)}
PROJECT_ROOT=${shellQuote(projectRoot)}
LOG_PATH=${shellQuote(logPath)}
DEBUG_PORT=${debuggingPort}

ACTIVE_REVISION=$("$NODE_BIN" -e '
  const fs = require("fs");
  try {
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).activeRevision;
    if (/^[0-9a-f]{40}$/.test(value)) process.stdout.write(value);
  } catch {}
' "$PROJECT_ROOT/.data/runtime-update.json")
ACTIVE_INJECTOR="$PROJECT_ROOT/.data/releases/$ACTIVE_REVISION/scripts/codex-injector.mjs"
if [[ -f "$ACTIVE_INJECTOR" ]]; then
  INJECTOR="$ACTIVE_INJECTOR"
else
  INJECTOR="$FALLBACK_INJECTOR"
fi

/bin/mkdir -p "$PROJECT_ROOT/.data"
exec >>"$LOG_PATH" 2>&1
echo "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] launcher invoked"

if [[ ! -d "$OFFICIAL_APP" ]]; then
  echo "Official Codex app is missing: $OFFICIAL_APP"
  /usr/bin/osascript -e 'display notification "找不到官方 Codex 应用" with title "任务面板启动失败"'
  exit 1
fi

if ! /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:$DEBUG_PORT/json/version" >/dev/null 2>&1; then
  existing_codex_pids=$(/usr/bin/pgrep -x ChatGPT || true)
  if [[ -n "$existing_codex_pids" ]]; then
    echo "Restarting Codex with the local debugging port"
    /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit'
    stopped=false
    for _ in {1..80}; do
      if ! /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1; then
        stopped=true
        break
      fi
      /bin/sleep 0.25
    done
    if [[ "$stopped" != true ]]; then
      echo "Timed out waiting for the existing Codex process to quit"
      /usr/bin/osascript -e 'display notification "请完全退出 Codex 后重试" with title "任务面板启动失败"'
      exit 1
    fi
  fi

  /usr/bin/open -n -a "$OFFICIAL_APP" --args \
    "--remote-debugging-port=$DEBUG_PORT" \
    "--remote-allow-origins=http://127.0.0.1:$DEBUG_PORT"

  ready=false
  for _ in {1..120}; do
    if /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:$DEBUG_PORT/json/version" >/dev/null 2>&1; then
      ready=true
      break
    fi
    /bin/sleep 0.25
  done
  if [[ "$ready" != true ]]; then
    echo "Timed out waiting for Codex CDP on port $DEBUG_PORT"
    /usr/bin/osascript -e 'display notification "Codex 调试端口未就绪" with title "任务面板启动失败"'
    exit 1
  fi
fi

if ! CODEX_TASKBOARD_HOST=127.0.0.1 CODEX_TASKBOARD_AUTO_UPDATE=0 "$NODE_BIN" "$INJECTOR" \
  --daemon --port "$DEBUG_PORT" --open; then
  echo "Failed to start the resident Taskboard injector"
  /usr/bin/osascript -e 'display notification "任务面板注入器启动失败" with title "任务面板启动失败"'
  exit 1
fi

if ! CODEX_TASKBOARD_HOST=127.0.0.1 CODEX_TASKBOARD_AUTO_UPDATE=0 "$NODE_BIN" "$INJECTOR" \
  --refresh-if-running --port "$DEBUG_PORT"; then
  echo "Taskboard sidebar entry verification failed"
  /usr/bin/osascript -e 'display notification "左侧任务面板入口加载失败" with title "任务面板启动失败"'
  exit 1
fi

/usr/bin/open -a "$OFFICIAL_APP"
echo "Taskboard launcher completed"
`;
}

function registerApplication(appPath) {
  spawnSync(launchServices, ["-f", appPath], { stdio: "ignore" });
}

function runPlistBuddy(command) {
  return spawnSync(plistBuddy, ["-c", command, dockPlist], { encoding: "utf8" });
}

async function repairLegacyDockItem() {
  if (!(await exists(dockPlist))) return;

  let changed = false;
  for (let index = 0; index < 100; index += 1) {
    const base = `:persistent-apps:${index}:tile-data`;
    const bundleResult = runPlistBuddy(`Print ${base}:bundle-identifier`);
    if (bundleResult.status !== 0) break;
    if (bundleResult.stdout.trim() !== officialBundleId) continue;

    const url = runPlistBuddy(`Print ${base}:file-data:_CFURLString`).stdout.trim();
    const label = runPlistBuddy(`Print ${base}:file-label`).stdout.trim();
    if (url !== legacyDockUrl && label !== ".ChatGPT Official") continue;

    const updates = [
      `Set ${base}:file-label Codex`,
      `Set ${base}:file-data:_CFURLString ${officialDockUrl}`,
    ];
    if (updates.some((command) => runPlistBuddy(command).status !== 0)) {
      console.warn("Could not update the legacy Codex Dock item");
      continue;
    }
    runPlistBuddy(`Delete ${base}:book`);
    changed = true;
  }

  if (changed) {
    spawnSync("/usr/bin/killall", ["Dock"], { stdio: "ignore" });
    console.log("Updated the Codex Dock item to use its normal name");
  }
}

async function migrateLegacyOfficialApp() {
  if (await exists(officialApp)) return;
  if (readBundleId(legacyOfficialApp) === officialBundleId) {
    await rename(legacyOfficialApp, officialApp);
    console.log(`Migrated official Codex app to ${officialApp}`);
  }
}

async function install({ launch }) {
  await migrateLegacyOfficialApp();
  const launcherExists = await exists(launcherApp);
  const officialExists = await exists(officialApp);
  const currentBundleId = launcherExists ? readBundleId(launcherApp) : null;

  if (launcherExists && currentBundleId === officialBundleId) {
    if (officialExists) {
      throw new Error(`${officialApp} already exists; refusing to overwrite it`);
    }
    await rename(launcherApp, officialApp);
  } else if (launcherExists && !compatibleLauncherBundleIds.has(currentBundleId)) {
    throw new Error(`${launcherApp} is not the official Codex app or the Taskboard launcher`);
  }

  if (readBundleId(officialApp) !== officialBundleId) {
    throw new Error(`Official Codex app was not found at ${officialApp}`);
  }

  if (await exists(launcherApp)) await rm(launcherApp, { recursive: true });
  const contents = path.join(launcherApp, "Contents");
  const macOS = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  await mkdir(macOS, { recursive: true });
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(contents, "Info.plist"), launcherPlist());
  await writeFile(path.join(macOS, launcherExecutable), launcherScript());
  await chmod(path.join(macOS, launcherExecutable), 0o755);
  await copyFile(
    path.join(officialApp, "Contents", "Resources", "app.icns"),
    path.join(resources, "app.icns"),
  );
  registerApplication(officialApp);
  registerApplication(launcherApp);
  await repairLegacyDockItem();

  console.log(`Installed Taskboard launcher at ${launcherApp}`);
  console.log(`Official Codex app is preserved at ${officialApp}`);
  if (launch) spawnSync("/usr/bin/open", [launcherApp], { stdio: "ignore" });
}

async function uninstall() {
  await migrateLegacyOfficialApp();
  if (!compatibleLauncherBundleIds.has(readBundleId(launcherApp))) {
    throw new Error(`Taskboard launcher was not found at ${launcherApp}`);
  }
  if (readBundleId(officialApp) !== officialBundleId) {
    throw new Error(`Official Codex app was not found at ${officialApp}`);
  }

  await rm(launcherApp, { recursive: true });
  await rename(officialApp, launcherApp);
  registerApplication(launcherApp);
  console.log(`Restored official Codex app at ${launcherApp}`);
}

const options = parseArgs(process.argv.slice(2));
if (options.uninstall) await uninstall();
else await install(options);
