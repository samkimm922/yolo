// Lifecycle guard CLI wrappers.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { join } from "node:path";
import {
  formatLifecycleGuardText,
  inspectLifecycleGuard,
} from "../../lifecycle/guard.js";

type GuardResult = Record<string, unknown>;
type GuardOptions = Record<string, unknown>;
type GuardIo = {
  stdout?: { write: (data: string) => void };
  stderr?: { write: (data: string) => void };
};

export function emitLifecycleGuard(result: GuardResult = {}, options: GuardOptions = {}, io: GuardIo = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else (result.status === "blocked" || result.status === "error" ? stderr : stdout).write(`${formatLifecycleGuardText(result)}\n`);
  return result.status === "blocked" || result.status === "error" ? 2 : 0;
}

export function inspectCliGuard(command: string, input: GuardResult = {}, options: GuardOptions = {}, projectRoot: string) {
  return inspectLifecycleGuard({
    ...input,
    command,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
  }, options);
}

export function guardBlocked(command: string, input: GuardResult = {}, options: GuardOptions = {}, projectRoot: string, io: GuardIo = {}) {
  const guard = inspectCliGuard(command, input, options, projectRoot);
  if (guard.status !== "pass") return emitLifecycleGuard(guard, options, io);
  return 0;
}
