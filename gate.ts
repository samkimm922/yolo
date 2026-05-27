#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGateCli } from "./src/cli/gate.js";

export { runGateCli } from "./src/cli/gate.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exit(runGateCli());
}
