#!/usr/bin/env node
// log-change.js — yolo 项目变更记录工具
// 用法:
//   node log-change.js start "描述" [--scope=infra] [--files=a.js,b.js]
//   node log-change.js complete "描述" [--scope=infra]
//   node log-change.js auto --file=path/to/file [--tool=Write|Edit]
//   node log-change.js event "事件描述" [--type=manual]

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOLO_ROOT = resolve(__dirname, "../../..");

function getRunId(stateDir) {
  const currentRunFile = join(stateDir, "runtime", "current-run.json");
  try {
    if (existsSync(currentRunFile)) {
      const raw = readFileSync(currentRunFile, "utf8");
      const data = JSON.parse(raw);
      return data.run_id || null;
    }
  } catch (_) {
    // silently ignore — run_id is best-effort
  }
  return null;
}

function parseArgs(args) {
  const positional = [];
  const named = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      named[key] = rest.join('=') || true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, named };
}

function timestamp() {
  return new Date().toISOString();
}

function resolveStateDir(named = {}) {
  if (named["state-dir"]) return resolve(String(named["state-dir"]));
  if (named["state-root"]) return join(resolve(String(named["state-root"])), "state");
  return join(YOLO_ROOT, "state");
}

function appendJsonl(file, obj) {
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

export function runLogChangeCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { positional, named } = parseArgs(argv);
  const action = positional[0];

  // Guard: reject flags passed as task_id
  if (action && action.startsWith("--")) {
    stderr.write("错误: 无效的命令名，以 -- 开头的不是有效命令\n");
    return 1;
  }

  const stateDir = resolveStateDir(named);
  mkdirSync(join(stateDir, "runtime"), { recursive: true });
  const changesFile = join(stateDir, "changes.jsonl");
  const eventsFile = join(stateDir, "events.jsonl");
  const run_id = getRunId(stateDir);

  switch (action) {
    case "start": {
      const description = positional[1] || "未命名任务";
      const entry = {
        status: "IN_PROGRESS",
        description,
        scope: named.scope || "general",
        files: named.files ? named.files.split(",") : [],
        desc: named.desc || "",
        ts: timestamp(),
        source: "manual",
        run_id
      };
      appendJsonl(changesFile, entry);
      stdout.write(`[log-change] IN_PROGRESS: ${description}\n`);
      break;
    }

    case "complete": {
      const description = positional[1] || "未命名任务";
      const entry = {
        status: "COMPLETED",
        description,
        scope: named.scope || "general",
        ts: timestamp(),
        source: "manual",
        run_id
      };
      appendJsonl(changesFile, entry);
      stdout.write(`[log-change] COMPLETED: ${description}\n`);
      break;
    }

    case "auto": {
      // Called by PreToolUse hook — minimal info
      const file = named.file || named.FILE_PATH || "unknown";
      const tool = named.tool || "unknown";
      const entry = {
        status: "AUTO_LOGGED",
        file,
        tool,
        ts: timestamp(),
        source: "hook",
        run_id
      };
      appendJsonl(changesFile, entry);
      // Don't print anything — hooks should be silent on success
      break;
    }

    case "event": {
      const description = positional[1] || "未命名事件";
      const entry = {
        type: named.type || "manual",
        description,
        ts: timestamp(),
        source: "manual",
        run_id
      };
      appendJsonl(eventsFile, entry);
      stdout.write(`[log-change] event: ${description}\n`);
      break;
    }

    default:
      stdout.write(`用法:
  node log-change.js start "描述" [--scope=infra] [--files=a.js,b.js]
  node log-change.js complete "描述" [--scope=infra]
  node log-change.js auto --file=path/to/file [--tool=Write|Edit]
  node log-change.js event "事件描述" [--type=manual]\n`);
      return 1;
  }
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exit(runLogChangeCli());
