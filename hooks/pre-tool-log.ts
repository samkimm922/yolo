#!/usr/bin/env node
// pre-tool-log.js — PreToolUse hook: auto-log yolo file changes
// Called by Claude Code before Write/Edit operations

import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, openSync, mkdirSync } from 'node:fs';

const YOLO_DIR = resolve(import.meta.dirname, '..');
const LOG_CHANGE = join(YOLO_DIR, 'dist/src/runtime/evidence/log-change.js');
const MEMORY_CENTER = join(YOLO_DIR, 'dist/src/runtime/devtools/memory-center.js');

// 不在 yolo 环境中时静默退出
if (!existsSync(LOG_CHANGE) && !existsSync(MEMORY_CENTER)) process.exit(0);

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const filePath = data.tool_input?.file_path || data.tool_input?.path || '';

    // Only log changes to yolo project files
    if (filePath && filePath.includes('scripts/yolo/')) {
      const toolName = data.tool_name || 'unknown';
      if (existsSync(LOG_CHANGE)) {
        execFileSync('node', [LOG_CHANGE, 'auto', `--file=${filePath}`, `--tool=${toolName}`], {
          stdio: 'pipe',
          cwd: YOLO_DIR
        });
      }

      // 去抖：30 秒内不重复触发 memory center 刷新
      const DEBOUNCE_FILE = join(YOLO_DIR, "state", "runtime", "memory-center-trigger.txt");
      const DEBOUNCE_MS = 30_000;
      let shouldRun = true;
      try {
        if (existsSync(DEBOUNCE_FILE)) {
          const lastRun = parseInt(readFileSync(DEBOUNCE_FILE, "utf8").trim(), 10);
          if (!isNaN(lastRun) && Date.now() - lastRun < DEBOUNCE_MS) {
            shouldRun = false;
          }
        }
      } catch {}
      if (shouldRun && existsSync(MEMORY_CENTER)) {
        try {
          mkdirSync(dirname(DEBOUNCE_FILE), { recursive: true });
          writeFileSync(DEBOUNCE_FILE, String(Date.now()), "utf8");
        } catch {}
        // Fire-and-forget: update docs in background without blocking the hook
        const logFile = join(YOLO_DIR, "state", "runtime", "hook-errors.log");
        try { mkdirSync(dirname(logFile), { recursive: true }); } catch {}
        let fd;
        try { fd = openSync(logFile, "a"); } catch { fd = 2; /* fallback to stderr */ }
        const child = spawn('node', [MEMORY_CENTER, "--legacy-pointers"], {
          detached: true,
          stdio: ["ignore", "ignore", fd],
          cwd: YOLO_DIR
        });
        child.unref();
      }
    }
  } catch (e) {
    // Silently ignore — hooks must not break tool execution
  }
});
