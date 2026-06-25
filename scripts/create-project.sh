#!/usr/bin/env bash
# Bootstraps this repo for local development: verifies the toolchain,
# installs npm dependencies, and ensures the public/models/ placeholder
# directories exist. Safe to re-run (idempotent) — does not overwrite any
# existing source files. Performs network access (npm install, and npm
# create vite only in the fallback branch below) — run it yourself; it is
# never executed automatically by any agent or tooling in this repo.
#
# Usage:
#   bash scripts/create-project.sh
#
# This script intentionally does NOT download model weight files — see
# public/models/README.md for that (separate, deliberate step with its own
# license due-diligence requirements). Models live under public/ (not a
# project-root models/) specifically so `vite build` ships them — see
# FILE_MAP_AND_TODO.md §3 if you're wondering why.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

log() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

log "Project root: $PROJECT_ROOT"

# --- 1. Toolchain checks ---------------------------------------------------

command -v node >/dev/null 2>&1 || fail "node not found on PATH. Install Node.js 20+ first."
command -v npm  >/dev/null 2>&1 || fail "npm not found on PATH. Install Node.js 20+ first (npm ships with it)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js 20+ is required (found $(node -v)). Upgrade Node and re-run this script."
fi
log "Node $(node -v) / npm $(npm -v) OK"

# --- 2. Scaffold fallback ---------------------------------------------------
# Normal case: package.json already exists (this repo ships a complete
# scaffold). Only fall back to `npm create vite` if running this script
# against an empty directory that somehow lost the committed scaffold files.

if [ ! -f package.json ]; then
  log "No package.json found — bootstrapping a fresh Vite + React + TypeScript project"
  read -r -p "This directory has no package.json. Run 'npm create vite' here now? [y/N] " confirm
  case "$confirm" in
    y|Y)
      npm create vite@latest . -- --template react-ts
      ;;
    *)
      fail "Aborted. Restore package.json from version control, or confirm to scaffold fresh."
      ;;
  esac
else
  log "package.json found — using existing scaffold (not re-running npm create vite)"
fi

# --- 3. Install dependencies -------------------------------------------------

log "Installing npm dependencies (requires network)"
npm install

# --- 4. Ensure public/models/ placeholder directories exist -----------------

log "Ensuring public/models/ placeholder directories exist"
for dir in public/models/detector public/models/embedder public/models/antispoof; do
  mkdir -p "$dir"
  if [ ! -f "$dir/.gitkeep" ]; then
    touch "$dir/.gitkeep"
    echo "  created $dir/.gitkeep"
  fi
done

# --- 5. Sanity-check for model weight files ----------------------------------

missing_models=0
[ -f public/models/detector/scrfd_tiny.onnx ]      || { echo "  missing: public/models/detector/scrfd_tiny.onnx";      missing_models=1; }
[ -f public/models/embedder/mobilefacenet.onnx ]   || { echo "  missing: public/models/embedder/mobilefacenet.onnx";    missing_models=1; }
[ -f public/models/antispoof/antispoof_tiny.onnx ] || { echo "  missing: public/models/antispoof/antispoof_tiny.onnx";  missing_models=1; }

if [ "$missing_models" -eq 1 ]; then
  log "Model weight files are not yet in place"
  echo "  The app will install and build, but inference will not run until you"
  echo "  source/convert real model files. See public/models/README.md for instructions."
else
  log "All expected model files found"
fi

# --- 6. Done ------------------------------------------------------------------

log "Setup complete"
echo "  Next steps:"
echo "    1. If you saw 'missing model files' above, follow public/models/README.md"
echo "    2. npm run dev"
echo "    3. Open the printed local URL in Chrome or Edge and grant camera access"
echo "  See README.md for the full quickstart and offline-face-recognition-spec.md"
echo "  for the full design."
