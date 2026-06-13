#!/usr/bin/env node
import { runYoloCli } from "../src/cli/yolo.js";

process.exitCode = await runYoloCli();
