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
  return WRITE_CASES.map(runWriteCase);
}
