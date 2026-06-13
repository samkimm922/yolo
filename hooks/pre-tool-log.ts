#!/usr/bin/env node
// pre-tool-log.js — PreToolUse hook: auto-log yolo file changes
// Called by Claude Code before Write/Edit operations

import { execFileSync } from 'node:child_process';
import { isAbsolute, normalize, relative, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

const YOLO_DIR = resolve(import.meta.dirname, '..');
const LOG_CHANGE = join(YOLO_DIR, 'dist/src/runtime/evidence/log-change.js');
const MEMORY_CENTER = join(YOLO_DIR, 'dist/src/devtools/memory-center.js');

function reportHookFailure({ hook, classification, stage, error }) {
  const payload = {
    status: classification === "mandatory" ? "blocked" : "warning",
    code: classification === "mandatory" ? "MANDATORY_HOOK_FAILED" : "OPTIONAL_HOOK_FAILED",
    hook,
    classification,
    stage,
    message: error?.message || String(error || "hook failed"),
  };
  const line = JSON.stringify(payload);
  if (classification === "mandatory") {
    console.error(line);
    process.exit(2);
  }
  console.warn(line);
}

function isInsideYolo(filePath) {
  if (!filePath) return false;
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath);
  const rel = relative(YOLO_DIR, normalize(absolutePath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// 不在 yolo 环境中时静默退出
if (!existsSync(LOG_CHANGE) && !existsSync(MEMORY_CENTER)) process.exit(0);

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch (error) {
    reportHookFailure({ hook: "pre-tool-log", classification: "mandatory", stage: "parse_input", error });
    return;
  }

  const filePath = data.tool_input?.file_path || data.tool_input?.path || '';

  // Only log changes to the real YOLO project root.
  if (isInsideYolo(filePath)) {
    const toolName = data.tool_name || 'unknown';
    if (existsSync(LOG_CHANGE)) {
      try {
        execFileSync('node', [LOG_CHANGE, 'auto', `--file=${filePath}`, `--tool=${toolName}`], {
          stdio: 'pipe',
          cwd: YOLO_DIR
        });
      } catch (error) {
        reportHookFailure({ hook: "pre-tool-log", classification: "mandatory", stage: "log_change", error });
        return;
      }
    }
  }
});
