#!/usr/bin/env node
// refresh-pin — repack the pinned tarball from the CURRENT checkout and write PIN.json.
//
// Discipline: only the human/main session runs this, from a verified main checkout, after
// landing a batch. The soak loop NEVER packs (that caused stale-pack bugs); it only reads
// PIN.json. This keeps a single trusted source for the pin the loop consumes each round.
//
// Output:
//   <dir>/yolo-0.1.0.tgz   — the packed tarball
//   <dir>/PIN.json         — { path, sha256, commit, packed_at } the soak loop reads
//
// Usage: npm run refresh-pin            (defaults dir to /tmp/yolo-pinned)
//        npm run refresh-pin -- /some/dir
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve(process.argv[2] || "/tmp/yolo-pinned");
const TARBALL = join(DIR, "yolo-0.1.0.tgz");
const PIN_JSON = join(DIR, "PIN.json");

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }).trim();
}

function main() {
  const commit = run("git", ["rev-parse", "HEAD"]);
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  // Guard: refuse to pin a dirty tree (the pin must reflect a clean, reviewable commit).
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    console.error("[refresh-pin] refusing to pin: tracked tree is dirty. Commit or stash first.");
    process.exit(1);
  }

  mkdirSync(DIR, { recursive: true });
  console.log(`[refresh-pin] building + packing from ${commit.slice(0, 9)} (${branch})`);
  run("npm", ["run", "build", "--silent"]);
  run("npm", ["pack", "--pack-destination", DIR, "--silent"]);

  const sha256 = createHash("sha256").update(readFileSync(TARBALL)).digest("hex");
  const pin = { path: TARBALL, sha256, commit, packed_at: new Date().toISOString() };
  writeFileSync(PIN_JSON, `${JSON.stringify(pin, null, 2)}\n`, "utf8");

  console.log(`[refresh-pin] tarball: ${TARBALL}`);
  console.log(`[refresh-pin] sha256:  ${sha256}`);
  console.log(`[refresh-pin] commit:  ${commit}`);
  console.log(`[refresh-pin] wrote ${PIN_JSON}`);
  console.log("[refresh-pin] soak loop reads PIN.json each round; it never packs.");
}

main();
