#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runYoloCli } from "./src/cli/yolo.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runYoloCli(["runner", ...process.argv.slice(2)]).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
