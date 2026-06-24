#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactDeep } from "../../lib/security/redact.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOLO_ROOT = resolve(__dirname, "../../..");

interface SessionMemoryCliIo {
  stdout?: Pick<NodeJS.WriteStream, "write">;
}

function argValue(argv: string[], prefix: string): string | null {
  const arg = argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

export function appendSessionMemory({ argv = [], now = new Date() }: { argv?: string[]; now?: Date } = Object()) {
  const record = {
    ts: now.toISOString(),
    type: argValue(argv, "--type=") || "note",
    source: argValue(argv, "--source=") || "unknown",
    summary: argValue(argv, "--summary=") || "",
    refs: (argValue(argv, "--refs=") || "").split(",").filter(Boolean),
  };
  // P10.S3 chokepoint: session-memory is a long-lived ledger that the progress
  // dashboard broadcasts verbatim via /lifecycle.json (readEvents walks state/*.jsonl).
  // summary/refs originate from runner checkpoints (task failReason, command output
  // fragments) which can carry secrets. Redact before persisting and before returning
  // so neither the JSONL record nor the CLI stdout can leak.
  const safeRecord = redactDeep(record);
  const stateRootArg = argValue(argv, "--state-root=") || argValue(argv, "--yolo-root=");
  const stateDirArg = argValue(argv, "--state-dir=");
  const stateDir = stateDirArg
    ? resolve(stateDirArg)
    : join(resolve(stateRootArg || YOLO_ROOT), "state");
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, "session-memory.jsonl");
  appendFileSync(file, `${JSON.stringify(safeRecord)}\n`, "utf8");
  return { status: "ok", file, record: safeRecord };
}

export function runSessionMemoryCli(argv: string[] = process.argv.slice(2), io: SessionMemoryCliIo = Object()) {
  const stdout = io.stdout || process.stdout;
  const result = appendSessionMemory({ argv });
  if (argv.includes("--json")) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(`[session-memory] wrote ${result.file}\n`);
  }
  return result;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runSessionMemoryCli();
