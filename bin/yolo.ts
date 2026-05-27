#!/usr/bin/env node
import { runYoloCli } from "../src/cli/yolo.js";

process.exit(await runYoloCli());
