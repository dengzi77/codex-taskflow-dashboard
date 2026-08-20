#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MANIFEST="$PROJECT_ROOT/package.json"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "The fixed Codex sidebar launcher currently supports macOS only." >&2
  exit 1
fi

if [ ! -f "$MANIFEST" ]; then
  echo "Run install.sh from a cloned codex-taskflow-dashboard repository." >&2
  exit 1
fi

NODE_BIN_DIR=$(sh "$PROJECT_ROOT/scripts/bootstrap-node.sh")
PATH="$NODE_BIN_DIR:$PATH"
export PATH

echo "Using Node.js $(node --version) and npm $(npm --version)"
cd "$PROJECT_ROOT"
npm ci --no-audit --no-fund
npm run taskctl:install
npm run build:web
npm run codex:install-launcher -- --launch

echo "Codex Taskflow Dashboard is installed."
echo "Data directory: $PROJECT_ROOT/.data"
