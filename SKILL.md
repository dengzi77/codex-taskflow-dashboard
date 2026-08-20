---
name: codex-taskflow-dashboard
description: Install, launch, update, uninstall, and verify the dengzi77/codex-taskflow-dashboard project, including its fixed Codex desktop sidebar entry on macOS.
---

# Codex Taskflow Dashboard

Complete the requested installation or maintenance operation; do not stop after only explaining commands.

## Install and verify

1. Confirm macOS 13+ and the official Codex desktop app at `/Applications/ChatGPT.app`.
2. Use `$HOME/.local/share/codex-taskflow-dashboard` unless the user specifies another absolute directory. Never overwrite a non-empty unrelated directory.
3. Download `dengzi77/codex-taskflow-dashboard` into that directory. Prefer `git clone`; if Git is unavailable, use `npx --yes degit` after bootstrapping Node.
4. Run `./install.sh` from the project root. The script bootstraps a checksum-verified official Node.js 22 runtime when needed, installs dependencies, builds the UI, installs `taskctl`, preserves the official app, and launches the sidebar-enabled wrapper.
5. After Codex reopens, verify all of the following:
   - `.data/codex-launcher.log` ends with `Taskboard launcher completed`;
   - the left sidebar contains “任务流看板”;
   - `command -v taskctl` succeeds in a fresh login shell;
   - `taskctl context current --json` succeeds;
   - `http://127.0.0.1:47823/health` returns `{"status":"ok"}` when the local service is active.
6. Report the installation directory, Node.js version, data directory, actual ports, and verification results.

Do not modify files inside the signed official Codex bundle. Do not delete `.data`. Only set `CODEX_TASKBOARD_AUTO_UPDATE=0` when the user explicitly asks to disable automatic updates.

## Uninstall

Run `npm run codex:uninstall-launcher` from the installation directory, verify that the official bundle is restored to `/Applications/ChatGPT.app`, and leave project data untouched unless the user separately authorizes deletion.
