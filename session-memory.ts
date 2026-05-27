#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSessionMemoryCli } from "./src/runtime/evidence/session-memory.js";

export * from "./src/runtime/evidence/session-memory.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runSessionMemoryCli();
