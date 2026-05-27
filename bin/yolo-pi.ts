#!/usr/bin/env node
import { runPiCli } from "../src/cli/pi.js";

process.exit(await runPiCli());
