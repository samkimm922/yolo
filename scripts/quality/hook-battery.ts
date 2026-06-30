import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

type HookBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

const require = createRequire(import.meta.url);
const TSX_LOADER = require.resolve("tsx");
const HOOK = join(process.cwd(), "hooks", "pre-tool-lifecycle-gate.ts");
const YOLO_WRITE_HOOK = join(process.cwd(), "hooks", "pre-tool-block-yolo-write.ts");

function writeBlockedStatus(root: string) {
  const dir = join(root, ".yolo", "lifecycle");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({
    stages: [{ id: "check", status: "blocked" }],
  }), "utf8");
}

function runHook(root: string, command: string) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, HOOK], {
    cwd: root,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
}

const WRITE_CASES = [
  {
    id: "bash_node_eval_write_to_source_blocks",
    command: "node -e \"require('fs').writeFileSync('src/p.ts', 'x')\"",
  },
  {
    id: "bash_python_eval_write_to_source_blocks",
    command: "python3 -c \"open('src/p.py', 'w').write('x')\"",
  },
  {
    id: "bash_cp_write_to_source_blocks",
    command: "cp README.md src/copied.ts",
  },
  {
    id: "bash_mv_write_to_source_blocks",
    command: "mv README.md src/moved.ts",
  },
  {
    id: "bash_touch_write_to_source_blocks",
    command: "touch src/touched.ts",
  },
  {
    id: "bash_rm_write_to_source_blocks",
    command: "rm src/p.ts",
  },
  // H5: expanded bash write-detection surface — each class must block.
  {
    id: "bash_ruby_eval_write_to_source_blocks",
    command: "ruby -e \"File.write('src/p.ts', 'x')\"",
  },
  {
    id: "bash_perl_eval_write_to_source_blocks",
    command: "perl -e \"open(F, '>src/p.ts'); print F 'x'\"",
  },
  {
    id: "bash_php_eval_write_to_source_blocks",
    command: "php -r 'file_put_contents(\"src/p.ts\", \"x\");'",
  },
  {
    id: "bash_node_promises_write_to_source_blocks",
    command: "node -e \"require('fs').promises.writeFile('src/p.ts', 'x')\"",
  },
  {
    id: "bash_ln_sf_write_to_source_blocks",
    command: "ln -sf /etc/hosts src/p.ts",
  },
  {
    id: "bash_install_write_to_source_blocks",
    command: "install -m 644 README.md src/p.ts",
  },
  {
    id: "bash_patch_write_to_source_blocks",
    command: "patch src/p.ts < /tmp/x.patch",
  },
  {
    id: "bash_git_apply_write_to_source_blocks",
    command: "git apply src/p.ts /tmp/x.diff",
  },
  {
    id: "bash_git_checkout_write_to_source_blocks",
    command: "git checkout -- src/p.ts",
  },
  {
    id: "bash_git_restore_write_to_source_blocks",
    command: "git restore src/p.ts",
  },
];

function runWriteCase(testCase: { id: string; command: string }): HookBatteryResult {
  const root = mkdtempSync(join(tmpdir(), "yolo-hook-battery-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
    writeFileSync(join(root, "src", "p.ts"), "export const p = 1;\n", "utf8");
    writeBlockedStatus(root);
    const result = runHook(root, testCase.command);
    const status = result.status === 2 ? "blocked" : "allowed";
    return {
      id: testCase.id,
      category: "lifecycle_hook_safety",
      expect: "blocked",
      actualExit: result.status ?? 1,
      actualStatus: status,
      correct: status === "blocked",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function runHookBattery(): HookBatteryResult[] {
  const results = WRITE_CASES.map(runWriteCase);
  // CR4: four confirmed hook bypasses — each must block; negatives must allow.
  results.push(...runCr4BypassCases());
  return results;
}

// CR4: exercise the two hooks that the four bypasses target.
// CR4.1 (path traversal) -> pre-tool-lifecycle-gate (Edit/Write file_path).
// CR4.2/3/4 (basename allowlist / $() descent / variable expansion) ->
//   pre-tool-block-yolo-write (Bash command touching .yolo state).
function runHookInput(root: string, hook: string, payload: unknown) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, hook], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

function cr4Result(id: string, exitCode: number | null, expectBlocked: boolean): HookBatteryResult {
  const status = exitCode === 2 ? "blocked" : "allowed";
  const correct = expectBlocked ? status === "blocked" : status === "allowed";
  return {
    id,
    category: "lifecycle_hook_safety",
    expect: expectBlocked ? "blocked" : "allowed",
    actualExit: exitCode ?? 1,
    actualStatus: status,
    correct,
  };
}

function runCr4BypassCases(): HookBatteryResult[] {
  const out: HookBatteryResult[] = [];
  const root = mkdtempSync(join(tmpdir(), "yolo-cr4-bypass-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "scratch"), { recursive: true });
    mkdirSync(join(root, ".yolo", "state"), { recursive: true });
    mkdirSync(join(root, ".yolo", "lifecycle"), { recursive: true });
    writeFileSync(join(root, ".yolo", "state", "events.jsonl"), "{}\n", "utf8");
    writeBlockedStatus(root);

    // CR4.1: `.yolo/../src/x.ts` must collapse to src/x.ts and be gated (not
    // early-exit-allowed by the `.yolo` exclude segment).
    out.push(cr4Result(
      "cr4_traversal_dotdot_collapses_before_exclude_blocks",
      runHookInput(root, HOOK, { tool_name: "Edit", tool_input: { file_path: ".yolo/../src/x.ts" } }).status,
      true,
    ));
    // CR4.1 negative: a legit excluded-dir path is still early-exit-allowed.
    out.push(cr4Result(
      "cr4_traversal_legit_excluded_dir_allows",
      runHookInput(root, HOOK, { tool_name: "Edit", tool_input: { file_path: ".yolo/config.json" } }).status,
      false,
    ));

    // CR4.2: a disk file named yolo.ts but NOT under the install root must not
    // be allowlisted (`node scratch/yolo.ts …`).
    out.push(cr4Result(
      "cr4_basename_scratch_yolo_script_blocks",
      runHookInput(root, YOLO_WRITE_HOOK, { tool_name: "Bash", tool_input: { command: "node scratch/yolo.ts read .yolo/state/events.jsonl" } }).status,
      true,
    ));

    // CR4.3: `$(…)` subshell content must be descended into.
    out.push(cr4Result(
      "cr4_subshell_descent_blocks",
      runHookInput(root, YOLO_WRITE_HOOK, { tool_name: "Bash", tool_input: { command: "yolo state read $(rm -rf .yolo)" } }).status,
      true,
    ));

    // CR4.4: variable/quote-concatenation that can hide `.yolo` is deny-by-default.
    out.push(cr4Result(
      "cr4_variable_concatenation_blocks",
      runHookInput(root, YOLO_WRITE_HOOK, { tool_name: "Bash", tool_input: { command: 'D=".yo""lo"; cat $D/state/events.jsonl' } }).status,
      true,
    ));

    // CR4 negatives: legit yolo CLI and an unrelated command must still be allowed.
    out.push(cr4Result(
      "cr4_legit_yolo_cli_allows",
      runHookInput(root, YOLO_WRITE_HOOK, { tool_name: "Bash", tool_input: { command: "yolo check" } }).status,
      false,
    ));
    out.push(cr4Result(
      "cr4_unrelated_command_allows",
      runHookInput(root, YOLO_WRITE_HOOK, { tool_name: "Bash", tool_input: { command: "ls -la" } }).status,
      false,
    ));

    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
