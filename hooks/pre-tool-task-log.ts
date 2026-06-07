#!/usr/bin/env node
// pre-tool-task-log.js — PreToolUse hook: auto-log TaskCreate/TaskUpdate to changes.jsonl

import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const YOLO_DIR = resolve(import.meta.dirname, '..');
const LOG_CHANGE = join(YOLO_DIR, 'dist/src/runtime/evidence/log-change.js');

function blockMandatoryHook(stage, error) {
  console.error(JSON.stringify({
    status: "blocked",
    code: "MANDATORY_HOOK_FAILED",
    hook: "pre-tool-task-log",
    classification: "mandatory",
    stage,
    message: error?.message || String(error || "hook failed"),
  }));
  process.exit(1);
}

// 不在 yolo 环境中时静默退出
if (!existsSync(LOG_CHANGE)) process.exit(0);

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch (error) {
    blockMandatoryHook("parse_input", error);
    return;
  }

  const toolName = data.tool_name || '';
  try {
    if (toolName === 'TaskCreate') {
      const subject = data.tool_input?.subject || '未命名任务';
      const description = data.tool_input?.description || '';
      const args = [
        LOG_CHANGE, 'start',
        subject,
        '--scope=task'
      ];
      if (description) {
        args.push(`--desc=${description.slice(0, 200)}`);
      }
      execFileSync('node', args, { stdio: 'pipe', cwd: YOLO_DIR });
    } else if (toolName === 'TaskUpdate') {
      const status = data.tool_input?.status || '';
      const taskId = data.tool_input?.taskId || '';
      if (status === 'completed') {
        execFileSync('node', [
          LOG_CHANGE, 'complete',
          `task#${taskId}`,
          '--scope=task'
        ], { stdio: 'pipe', cwd: YOLO_DIR });
      }
    }
  } catch (error) {
    blockMandatoryHook("log_change", error);
  }
});
