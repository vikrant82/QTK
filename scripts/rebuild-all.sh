#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: scripts/rebuild-all.sh [--skip-core] [--skip-plugin] [--release|--debug]

Rebuilds QTK's opencode plugin and optional Rust sidecar.

Options:
  --skip-core      Do not build packages/qtk-core.
  --skip-plugin    Do not build packages/qtk-plugin.
  --release        Build qtk-core in release mode (default).
  --debug          Build qtk-core in debug mode.
  -h, --help       Show this help.

After rebuilding, restart opencode so it reloads the plugin and qtk.toml.
USAGE
}

build_core=1
build_plugin=1
core_profile="release"

while (($#)); do
  case "$1" in
    --skip-core)
      build_core=0
      ;;
    --skip-plugin)
      build_plugin=0
      ;;
    --release)
      core_profile="release"
      ;;
    --debug)
      core_profile="debug"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 127
  fi
}

echo "QTK root: $ROOT"

if [[ "$build_plugin" == 1 ]]; then
  need_cmd bun
  echo
  echo "==> Building qtk-plugin"
  (cd "$ROOT/packages/qtk-plugin" && bun run build)

  plugin_out="$ROOT/packages/qtk-plugin/dist/index.js"
  if [[ ! -s "$plugin_out" ]]; then
    echo "plugin build did not produce $plugin_out" >&2
    exit 1
  fi
  echo "ok: $plugin_out"
fi

if [[ "$build_core" == 1 ]]; then
  need_cmd cargo
  echo
  echo "==> Building qtk-core ($core_profile)"
  if [[ "$core_profile" == "release" ]]; then
    (cd "$ROOT/packages/qtk-core" && cargo build --release)
    core_out="$ROOT/packages/qtk-core/target/release/qtk-core"
  else
    (cd "$ROOT/packages/qtk-core" && cargo build)
    core_out="$ROOT/packages/qtk-core/target/debug/qtk-core"
  fi

  if [[ ! -x "$core_out" ]]; then
    echo "core build did not produce executable $core_out" >&2
    exit 1
  fi
  echo "ok: $core_out"
fi

echo
echo "Rebuild complete. Restart opencode to load the rebuilt plugin/config."
