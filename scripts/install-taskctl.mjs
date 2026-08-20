#!/usr/bin/env node

import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const pathBlockStart = "# >>> codex-taskflow-dashboard taskctl >>>";
const compatiblePathBlockStarts = [
  pathBlockStart,
  "# >>> codex-one-person-board taskctl >>>",
];
const pathBlock = `${pathBlockStart}
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
# <<< codex-taskflow-dashboard taskctl <<<`;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function shellProfile(homeDirectory, shell = process.env.SHELL || "") {
  if (shell.endsWith("/bash")) return path.join(homeDirectory, ".bash_profile");
  if (shell.endsWith("/zsh") || process.platform === "darwin") {
    return path.join(homeDirectory, ".zprofile");
  }
  return path.join(homeDirectory, ".profile");
}

async function ensureUserPath(profilePath) {
  const current = await exists(profilePath) ? await readFile(profilePath, "utf8") : "";
  if (compatiblePathBlockStarts.some((marker) => current.includes(marker))) return false;
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await writeFile(profilePath, `${current}${separator}\n${pathBlock}\n`);
  return true;
}

export async function installTaskctl({
  homeDirectory = process.env.HOME,
  shell = process.env.SHELL,
  nodePath = process.execPath,
  rootDirectory = projectRoot,
} = {}) {
  if (!homeDirectory) throw new Error("HOME is required to install taskctl");

  const binDirectory = path.join(homeDirectory, ".local", "bin");
  const commandPath = path.join(binDirectory, "taskctl");
  const taskctlPath = path.join(rootDirectory, "cli", "taskctl.mjs");
  if (!(await exists(taskctlPath))) throw new Error(`taskctl entrypoint not found: ${taskctlPath}`);

  await mkdir(binDirectory, { recursive: true });
  await writeFile(
    commandPath,
    `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(taskctlPath)} "$@"\n`,
  );
  await chmod(commandPath, 0o755);

  const profilePath = shellProfile(homeDirectory, shell);
  const profileUpdated = await ensureUserPath(profilePath);
  return { commandPath, profilePath, profileUpdated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await installTaskctl();
  console.log(`Installed taskctl at ${result.commandPath}`);
  console.log(
    result.profileUpdated
      ? `Added ~/.local/bin to ${result.profilePath}`
      : `User PATH is already configured in ${result.profilePath}`,
  );
  console.log('Run export PATH="$HOME/.local/bin:$PATH" to use taskctl in the current shell.');
}
