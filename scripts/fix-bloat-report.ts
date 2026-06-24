#!/usr/bin/env node
// fix-bloat-report — an ADVISORY for human review of a soak fix branch.
//
// The objective gates (test/typecheck/mutation/matrix/quality/ratchet) prove a fix is
// CORRECT. They say nothing about whether it is BLOATED or low-quality. This advisory
// surfaces the signals a reviewer should scrutinize before merging:
//   - oversized diff / too many files / large net growth
//   - new files (a YB fix is usually a guard, not a new module)
//   - source changed without a matching test
//   - a single very long added function (a hint of copy-paste / wrong abstraction)
//
// In advisory mode it exits 0 and never blocks a merge. A human reads the flags
// and decides. In --gate mode, invalid git inputs and egregious bloat fail closed.
import { execFileSync } from "node:child_process";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BASE = positional[0] || "origin/main";
const HEAD = positional[1] || "HEAD";
const HARD_GATE = process.argv.includes("--gate");

// Returns the reason from a `[bloat-ack: <reason>]` marker in any commit message of the
// PR range (BASE..HEAD), or null. Lets a human deliberately acknowledge a reviewed large
// change while keeping the gate hard for unattended/agent merges (which never add it).
function bloatAckReason(): string | null {
  try {
    const log = execFileSync("git", ["log", `${BASE}..${HEAD}`, "--format=%B"], { encoding: "utf8" });
    // Must START a line (a deliberate dedicated line, like a conventional-commit footer) —
    // so prose merely mentioning the marker (e.g. this feature's own docs) does not trigger.
    const m = log.match(/^\[bloat-ack:\s*([^\]]+)\]/im);
    const reason = m ? m[1].trim() : "";
    if (!reason || reason === "<reason>") return null; // ignore the placeholder
    return reason;
  } catch {
    return null;
  }
}

// Thresholds tuned for "a focused YB fix + its regression test". Above these, a reviewer
// should look harder — not necessarily reject.
const FLAG = {
  totalLines: 200,        // net churn across the whole diff
  files: 8,               // distinct files touched
  addedPerFile: 150,      // a single file growing a lot
  functionLines: 60,      // a single added function this long
};

// Hard-block thresholds for --gate mode. Deliberately generous: only an obvious
// rewrite / sprawl / giant pasted function blocks an unattended auto-merge. Normal
// focused fixes (even multi-YB ones like #56 at ~200 lines) pass.
const GATE = {
  totalLines: 400,
  files: 12,
  functionLines: 120,
};

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    return String((error as { stdout?: string }).stdout || "").trim();
  }
}

function gateGit(args: string[], description: string): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr || "").trim();
    console.error(`[fix-bloat] GATE FAILED — cannot ${description}.`);
    if (stderr) console.error(stderr);
    process.exit(1);
  }
}

function validateGateRange() {
  if (!HARD_GATE) return;
  gateGit(["rev-parse", "--verify", `${BASE}^{commit}`], `resolve base ref ${BASE}`);
  gateGit(["rev-parse", "--verify", `${HEAD}^{commit}`], `resolve head ref ${HEAD}`);
  gateGit(["merge-base", BASE, HEAD], `find merge-base for ${BASE} and ${HEAD}`);
}

type FileStat = { file: string; added: number; removed: number };

function numstat(): FileStat[] {
  const out = git(["diff", "--numstat", `${BASE}...${HEAD}`]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [a, r, file] = line.split("\t");
    return { file, added: a === "-" ? 0 : Number(a) || 0, removed: r === "-" ? 0 : Number(r) || 0 };
  });
}

function isTest(file: string): boolean {
  return file.includes("__tests__/") || file.endsWith(".test.ts") || file.startsWith("scripts/quality/");
}
function isSource(file: string): boolean {
  return file.startsWith("src/") && file.endsWith(".ts") && !file.endsWith(".test.ts");
}

// Heuristic: longest run of consecutive added lines that looks like one function body.
function longestAddedFunction(): { file: string; lines: number } {
  const diff = git(["diff", `${BASE}...${HEAD}`]);
  let curFile = "";
  let worst = { file: "", lines: 0 };
  let run = 0;
  let runFile = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) { curFile = line.slice(6); continue; }
    // Only source files: long runs in data arrays (battery/test fixtures) are expected.
    if (line.startsWith("+") && !line.startsWith("+++") && isSource(curFile)) {
      if (run === 0) runFile = curFile;
      run += 1;
      if (run > worst.lines) worst = { file: runFile, lines: run };
    } else if (!line.startsWith("-")) {
      run = 0; // a context line breaks the run; an unchanged line means not one solid block
    }
  }
  return worst;
}

function main() {
  validateGateRange();
  const base = git(["merge-base", BASE, HEAD]);
  const stats = numstat();
  if (stats.length === 0) {
    console.log(`[fix-bloat] no diff vs ${BASE} (merge-base ${base.slice(0, 9)}). Nothing to review.`);
    return;
  }

  const added = stats.reduce((s, f) => s + f.added, 0);
  const removed = stats.reduce((s, f) => s + f.removed, 0);
  const total = added + removed;
  const srcFiles = stats.filter((f) => isSource(f.file));
  const testFiles = stats.filter((f) => isTest(f.file));
  const newFiles = git(["diff", "--name-only", "--diff-filter=A", `${BASE}...${HEAD}`]).split("\n").filter(Boolean);
  const biggest = [...stats].sort((a, b) => b.added - a.added)[0];
  const longestFn = longestAddedFunction();

  console.log(`[fix-bloat] advisory vs ${BASE} (merge-base ${base.slice(0, 9)})`);
  console.log(`  diff: +${added} / -${removed}  total ${total}  files ${stats.length}`);
  console.log(`  source files: ${srcFiles.length}  test/battery files: ${testFiles.length}  new files: ${newFiles.length}`);
  console.log(`  largest file: ${biggest.file} (+${biggest.added})`);
  console.log(`  longest added block: ${longestFn.lines} lines (${longestFn.file || "n/a"})`);

  const flags: string[] = [];
  if (total > FLAG.totalLines) flags.push(`LARGE_DIFF: ${total} lines > ${FLAG.totalLines} — confirm the fix is minimal, not a rewrite.`);
  if (stats.length > FLAG.files) flags.push(`MANY_FILES: ${stats.length} files > ${FLAG.files} — confirm the change is focused, not sprawling.`);
  if (biggest && biggest.added > FLAG.addedPerFile) flags.push(`BIG_FILE_GROWTH: ${biggest.file} +${biggest.added} > ${FLAG.addedPerFile}.`);
  if (longestFn.lines > FLAG.functionLines) flags.push(`LONG_BLOCK: ${longestFn.lines}-line added block in ${longestFn.file} — check for copy-paste / over-long function.`);
  if (srcFiles.length > 0 && testFiles.length === 0) flags.push("SRC_WITHOUT_TEST: source changed but no test/battery case added — a YB fix should carry a regression test.");
  for (const f of newFiles.filter((f) => isSource(f))) flags.push(`NEW_SOURCE_FILE: ${f} — a YB fix is usually a guard in an existing file, not a new module.`);

  if (flags.length === 0) {
    console.log("[fix-bloat] OK — no bloat flags. (Still eyeball the diff for naming/abstraction.)");
  } else {
    console.log("[fix-bloat] REVIEW FLAGS:");
    for (const f of flags) console.log(`  ⚠ ${f}`);
  }

  // Hard gate (--gate): for UNATTENDED auto-merge, block only EGREGIOUS bloat (a clear
  // rewrite / sprawl / giant pasted function). Normal focused fixes pass. Subtle quality
  // (naming, abstraction) is NOT gated — that is the accepted trade-off of auto-merge.
  if (HARD_GATE) {
    const blocks: string[] = [];
    if (total > GATE.totalLines) blocks.push(`EGREGIOUS_DIFF: ${total} lines > ${GATE.totalLines}`);
    if (stats.length > GATE.files) blocks.push(`EGREGIOUS_FILES: ${stats.length} files > ${GATE.files}`);
    if (longestFn.lines > GATE.functionLines) blocks.push(`EGREGIOUS_BLOCK: ${longestFn.lines}-line added block in ${longestFn.file} > ${GATE.functionLines}`);
    if (blocks.length > 0) {
      // Auditable human-review escape. This gate exists to stop UNATTENDED auto-merge of
      // egregious sprawl — soak/agent prompts never carry this marker, so unattended merges
      // stay hard-blocked. A human who has reviewed a legitimately large change (e.g. a new
      // module landing with its full test) can add `[bloat-ack: <reason>]` to a commit
      // message; the reason stays auditable in git history.
      const ack = bloatAckReason();
      if (ack) {
        console.warn("[fix-bloat] EGREGIOUS bloat ACKNOWLEDGED by human review via [bloat-ack]:");
        for (const b of blocks) console.warn(`  ⚠ ${b}`);
        console.warn(`  reason: ${ack}`);
        console.warn("[fix-bloat] downgraded to warning (auditable in commit history; unattended merges never carry this marker).");
      } else {
        console.error("[fix-bloat] GATE FAILED — change is too large/sprawling for unattended merge:");
        for (const b of blocks) console.error(`  ✗ ${b}`);
        console.error("[fix-bloat] split into a smaller, focused fix, or — if a human has reviewed it — add [bloat-ack: <reason>] to a commit message.");
        process.exit(1);
      }
    } else {
      console.log("[fix-bloat] GATE OK — diff is within egregious-bloat limits.");
    }
  }
}

main();
