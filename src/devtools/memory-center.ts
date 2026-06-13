#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMemoryCenterCli } from "../runtime/memory/center.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = runMemoryCenterCli(process.argv.slice(2));
  if (result.status !== "ok") process.exit(1);
}

export * from "../runtime/memory/center.js";
