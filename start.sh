#!/bin/bash
# YOLO root compatibility launcher.
# Prefer the stable 8-entry CLI: status, demand, spec, tasks, run, check, review, release.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$SCRIPT_DIR/dist/bin/yolo.js" ]; then
  YOLO=(node "$SCRIPT_DIR/dist/bin/yolo.js")
else
  YOLO=(node --import tsx "$SCRIPT_DIR/bin/yolo.ts")
fi

if [ "$#" -eq 0 ]; then
  echo "[start] No command provided; showing current YOLO status."
  exec "${YOLO[@]}" status
fi

case "$1" in
  status|demand|spec|tasks|run|check|review|release)
    exec "${YOLO[@]}" "$@"
    ;;
  *)
    echo "[start] Compatibility mode: routing arguments to 'yolo run'."
    exec "${YOLO[@]}" run "$@"
    ;;
esac
