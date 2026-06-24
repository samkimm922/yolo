import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cleanupTaskWorktree } from "../../src/runtime/execution/worktree-session.js";

type WorktreeBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

function runPathEscapeCase(): WorktreeBatteryResult {
  const root = mkdtempSync(join(tmpdir(), "yolo-worktree-battery-"));
  try {
    const repo = join(root, "repo");
    const wt = join(root, "worktrees", "task");
    mkdirSync(repo, { recursive: true });
    mkdirSync(wt, { recursive: true });

    const escapeTarget = `../../${root.split("/").pop()}-outside.txt`;
    const srcOutsideWt = resolve(wt, escapeTarget);
    const dstOutsideRepo = resolve(repo, escapeTarget);
    rmSync(dstOutsideRepo, { force: true });
    mkdirSync(resolve(srcOutsideWt, ".."), { recursive: true });
    writeFileSync(srcOutsideWt, "ESCAPE_FROM_WORKTREE", "utf8");

    let status = "blocked";
    try {
      cleanupTaskWorktree({
        wtPath: wt,
        wtBranch: "g1-path-escape",
        rootDir: repo,
        mergeToMain: true,
        allowedScope: { targets: [{ file: escapeTarget }] },
        execSync: () => { throw new Error("not git"); },
        execFileSync: () => "",
        log: () => {},
      });
      status = readFileSync(dstOutsideRepo, "utf8") === "ESCAPE_FROM_WORKTREE" ? "escaped" : "blocked";
    } catch {
      status = "blocked";
    }

    return {
      id: "worktree_merge_path_escape_blocks",
      category: "worktree_merge_safety",
      expect: "blocked",
      actualExit: status === "blocked" ? 1 : 0,
      actualStatus: status,
      correct: status === "blocked",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function runWorktreeBattery(): WorktreeBatteryResult[] {
  return [runPathEscapeCase()];
}
