#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLearnCli } from "./src/runtime/learning/learn.js";

export * from "./src/runtime/learning/learn.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runLearnCli();
