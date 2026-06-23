// Lifecycle guard CLI wrappers.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { join } from "node:path";
import {
  formatLifecycleGuardText,
  inspectLifecycleGuard,
} from "../../lifecycle/guard.js";

export function emitLifecycleGuard(result = Object(), options = Object(), io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else (result.status === "blocked" || result.status === "error" ? stderr : stdout).write(`${formatLifecycleGuardText(result)}\n`);
  return result.status === "blocked" || result.status === "error" ? 2 : 0;
}

export function inspectCliGuard(command, input = Object(), options = Object(), projectRoot) {
  return inspectLifecycleGuard({
    ...input,
    command,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
  }, options);
}

export function guardBlocked(command, input = Object(), options = Object(), projectRoot, io = Object()) {
  const guard = inspectCliGuard(command, input, options, projectRoot);
  if (guard.status !== "pass") return emitLifecycleGuard(guard, options, io);
  return 0;
}
