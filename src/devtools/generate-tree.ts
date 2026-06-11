#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshMemoryCenter } from "../runtime/memory/center.js";

export function runGenerateTreeCli(argv = process.argv.slice(2), io = {}) {
  const result = refreshMemoryCenter({
    dryRun: argv.includes("--dry-run"),
    writeLegacyPointers: true,
  });
  const stdout = io.stdout || process.stdout;
  if (argv.includes("--json")) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(`[generate-tree] compatibility refresh wrote ${result.written.length} memory docs\n`);
  }
  return result;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = runGenerateTreeCli();
  if (result.status !== "ok") process.exit(1);
}
