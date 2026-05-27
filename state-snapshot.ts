#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStateSnapshotCli } from "./src/runtime/evidence/state-snapshot.js";

export * from "./src/runtime/evidence/state-snapshot.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runStateSnapshotCli();
