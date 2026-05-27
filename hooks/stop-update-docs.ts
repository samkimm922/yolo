#!/usr/bin/env node
// stop-update-docs.js — Stop hook: auto-update yolo docs on session end

import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

const YOLO_DIR = resolve(import.meta.dirname, '..');
const MEMORY_CENTER = join(YOLO_DIR, 'dist/src/runtime/devtools/memory-center.js');

// 不在 yolo 环境中时静默退出（worktree 已清理等场景）
if (!existsSync(MEMORY_CENTER)) process.exit(0);

try {
  // Always run on session end to ensure final doc state is correct
  execFileSync('node', [MEMORY_CENTER, '--legacy-pointers'], { stdio: 'pipe', cwd: YOLO_DIR });
} catch (e) {
  // Silently ignore — stop hooks must not break anything
}
