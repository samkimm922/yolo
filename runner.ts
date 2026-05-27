#!/usr/bin/env node
// Compatibility entrypoint. Runner implementation lives in src/runtime/runner-core.js.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run, runCli } from "./src/runtime/runner-core.js";

export { run, runCli };

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runCli();
}
