#!/usr/bin/env tsx
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function runTsc(filePath: string) {
  return spawnSync("npx", [
    "tsc",
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    filePath,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const root = mkdtempSync(join(tmpdir(), "yolo-typecheck-guard-"));
try {
  const passFile = join(root, "pass.ts");
  const failFile = join(root, "fail.ts");
  writeFileSync(passFile, "const value: string = 'ok';\nvoid value;\n", "utf8");
  writeFileSync(failFile, "const value: string = 1;\nvoid value;\n", "utf8");

  const pass = runTsc(passFile);
  if (pass.status !== 0) {
    process.stderr.write(`typecheck guard expected valid TypeScript to pass\n${pass.stdout}${pass.stderr}`);
    process.exit(1);
  }

  const fail = runTsc(failFile);
  if (fail.status === 0 || !/TS2322/.test(`${fail.stdout}${fail.stderr}`)) {
    process.stderr.write("typecheck guard expected intentional TS2322 type error to fail\n");
    process.exit(1);
  }

  process.stdout.write("typecheck guard: strict TypeScript probe passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
