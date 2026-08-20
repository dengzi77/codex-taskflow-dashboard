#!/bin/sh

set -eu

TASKBOARD_RUNTIME_ROOT="${CODEX_TASKBOARD_RUNTIME_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-taskflow-dashboard-runtime}"
TASKBOARD_CURRENT_BIN_FILE="$TASKBOARD_RUNTIME_ROOT/current-bin"
TASKBOARD_NODE_BASE_URL="https://nodejs.org/dist/latest-v22.x"

node_runtime_is_usable() {
  TASKBOARD_NODE_COMMAND="$1"
  [ -x "$TASKBOARD_NODE_COMMAND" ] || return 1
  "$TASKBOARD_NODE_COMMAND" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1);
  ' >/dev/null 2>&1 || return 1
  TASKBOARD_NODE_BIN=$(dirname "$TASKBOARD_NODE_COMMAND")
  [ -x "$TASKBOARD_NODE_BIN/npm" ] && [ -x "$TASKBOARD_NODE_BIN/npx" ]
}

if [ -f "$TASKBOARD_CURRENT_BIN_FILE" ]; then
  IFS= read -r TASKBOARD_MANAGED_BIN < "$TASKBOARD_CURRENT_BIN_FILE" || true
  if node_runtime_is_usable "$TASKBOARD_MANAGED_BIN/node"; then
    printf '%s\n' "$TASKBOARD_MANAGED_BIN"
    exit 0
  fi
fi

if command -v node >/dev/null 2>&1 && node_runtime_is_usable "$(command -v node)"; then
  printf '%s\n' "$TASKBOARD_NODE_BIN"
  exit 0
fi

download_file() {
  TASKBOARD_DOWNLOAD_URL="$1"
  TASKBOARD_DOWNLOAD_TARGET="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$TASKBOARD_DOWNLOAD_URL" -o "$TASKBOARD_DOWNLOAD_TARGET"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$TASKBOARD_DOWNLOAD_TARGET" "$TASKBOARD_DOWNLOAD_URL"
    return
  fi
  printf '%s\n' "Node.js bootstrap requires curl or wget." >&2
  exit 1
}

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) TASKBOARD_NODE_PLATFORM="darwin-arm64" ;;
  Darwin:x86_64) TASKBOARD_NODE_PLATFORM="darwin-x64" ;;
  Linux:aarch64|Linux:arm64) TASKBOARD_NODE_PLATFORM="linux-arm64" ;;
  Linux:x86_64) TASKBOARD_NODE_PLATFORM="linux-x64" ;;
  *)
    printf '%s\n' "Automatic Node.js bootstrap supports macOS and Linux on arm64 or x64." >&2
    exit 1
    ;;
esac

command -v tar >/dev/null 2>&1 || {
  printf '%s\n' "Node.js bootstrap requires tar." >&2
  exit 1
}

mkdir -p "$TASKBOARD_RUNTIME_ROOT"
TASKBOARD_TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/codex-taskboard-node.XXXXXX")
cleanup() {
  rm -rf "$TASKBOARD_TEMP_DIR"
}
trap cleanup EXIT HUP INT TERM

TASKBOARD_SHASUMS_FILE="$TASKBOARD_TEMP_DIR/SHASUMS256.txt"
download_file "$TASKBOARD_NODE_BASE_URL/SHASUMS256.txt" "$TASKBOARD_SHASUMS_FILE"
TASKBOARD_NODE_ARCHIVE=$(awk -v suffix="-$TASKBOARD_NODE_PLATFORM.tar.gz" '
  length($2) >= length(suffix) && substr($2, length($2) - length(suffix) + 1) == suffix {
    print $2;
    exit;
  }
' "$TASKBOARD_SHASUMS_FILE")
case "$TASKBOARD_NODE_ARCHIVE" in
  node-v22.*-darwin-arm64.tar.gz|node-v22.*-darwin-x64.tar.gz|node-v22.*-linux-arm64.tar.gz|node-v22.*-linux-x64.tar.gz) ;;
  *)
    printf '%s\n' "Could not resolve an official Node.js 22 archive." >&2
    exit 1
    ;;
esac

TASKBOARD_EXPECTED_SHA=$(awk -v archive="$TASKBOARD_NODE_ARCHIVE" '$2 == archive { print $1; exit }' "$TASKBOARD_SHASUMS_FILE")
[ -n "$TASKBOARD_EXPECTED_SHA" ] || {
  printf '%s\n' "Could not resolve the Node.js archive checksum." >&2
  exit 1
}

TASKBOARD_ARCHIVE_PATH="$TASKBOARD_TEMP_DIR/$TASKBOARD_NODE_ARCHIVE"
printf '%s\n' "Installing official Node.js 22 runtime..." >&2
download_file "$TASKBOARD_NODE_BASE_URL/$TASKBOARD_NODE_ARCHIVE" "$TASKBOARD_ARCHIVE_PATH"

if command -v shasum >/dev/null 2>&1; then
  TASKBOARD_ACTUAL_SHA=$(LC_ALL=C LANG=C shasum -a 256 "$TASKBOARD_ARCHIVE_PATH" | awk '{ print $1 }')
elif command -v sha256sum >/dev/null 2>&1; then
  TASKBOARD_ACTUAL_SHA=$(LC_ALL=C LANG=C sha256sum "$TASKBOARD_ARCHIVE_PATH" | awk '{ print $1 }')
elif command -v openssl >/dev/null 2>&1; then
  TASKBOARD_ACTUAL_SHA=$(LC_ALL=C LANG=C openssl dgst -sha256 "$TASKBOARD_ARCHIVE_PATH" | awk '{ print $NF }')
else
  printf '%s\n' "Node.js bootstrap requires shasum, sha256sum, or openssl." >&2
  exit 1
fi

[ "$TASKBOARD_ACTUAL_SHA" = "$TASKBOARD_EXPECTED_SHA" ] || {
  printf '%s\n' "Node.js archive checksum verification failed." >&2
  exit 1
}

TASKBOARD_UNPACKED_ROOT="$TASKBOARD_TEMP_DIR/unpacked"
TASKBOARD_NODE_DIRECTORY_NAME=${TASKBOARD_NODE_ARCHIVE%.tar.gz}
TASKBOARD_NODE_TARGET="$TASKBOARD_RUNTIME_ROOT/$TASKBOARD_NODE_DIRECTORY_NAME"
mkdir -p "$TASKBOARD_UNPACKED_ROOT"
LC_ALL=C LANG=C tar -xzf "$TASKBOARD_ARCHIVE_PATH" -C "$TASKBOARD_UNPACKED_ROOT"

if [ ! -d "$TASKBOARD_NODE_TARGET" ]; then
  mv "$TASKBOARD_UNPACKED_ROOT/$TASKBOARD_NODE_DIRECTORY_NAME" "$TASKBOARD_NODE_TARGET"
fi

TASKBOARD_NODE_BIN="$TASKBOARD_NODE_TARGET/bin"
node_runtime_is_usable "$TASKBOARD_NODE_BIN/node" || {
  printf '%s\n' "Installed Node.js runtime is incomplete: $TASKBOARD_NODE_TARGET" >&2
  exit 1
}

TASKBOARD_CURRENT_BIN_TEMP="$TASKBOARD_RUNTIME_ROOT/.current-bin.$$"
printf '%s\n' "$TASKBOARD_NODE_BIN" > "$TASKBOARD_CURRENT_BIN_TEMP"
mv "$TASKBOARD_CURRENT_BIN_TEMP" "$TASKBOARD_CURRENT_BIN_FILE"
printf '%s\n' "$TASKBOARD_NODE_BIN"
