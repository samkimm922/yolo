import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const PROJECT_STATE_SCHEMA = "yolo.demand.project_state.v1";

// 源码扩展名（用于判断项目是否已有实现代码，而非靠用户措辞判断 brownfield）。
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".kt", ".rb", ".php", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".swift",
  ".vue", ".svelte", ".scala", ".dart", ".ex", ".exs",
]);

// 扫描时跳过的目录：依赖、版本控制、构建产物、YOLO 自身状态目录。
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".yolo", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".cache", "vendor", "target", "__pycache__", ".venv", "venv",
]);

// 默认阈值：源码文件数超过此值即视为"已开发项目"。
const DEFAULT_SOURCE_FILE_THRESHOLD = 1;

function extname(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot >= 0 ? file.slice(dot).toLowerCase() : "";
}

function countSourceFiles(root: string, limit: number): number {
  let count = 0;
  const stack: string[] = [root];
  while (stack.length > 0 && count <= limit) {
    const dir = stack.pop() as string;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".") {
        // 跳过隐藏目录里的源码扫描（保留对显式源码目录的扫描）
      }
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(path);
      } else if (SOURCE_EXTENSIONS.has(extname(entry))) {
        count += 1;
        if (count > limit) break;
      }
    }
  }
  return count;
}

function gitCommitCount(root: string): number {
  try {
    const out = execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export interface ProjectState {
  schema: string;
  project_root: string;
  has_existing_code: boolean;
  source_file_count: number;
  git_commit_count: number;
}

// 从项目实际文件系统 + git 历史检测是否为"已开发项目"，而非依赖用户描述的关键词。
// 已有代码 → 必须走 brownfield / 项目阅读 grounding 路径，无论用户怎么表述。
export function detectProjectState(projectRoot: string, options: { sourceFileThreshold?: number } = Object()): ProjectState {
  const threshold = Number.isFinite(options.sourceFileThreshold as number)
    ? (options.sourceFileThreshold as number)
    : DEFAULT_SOURCE_FILE_THRESHOLD;
  const root = String(projectRoot || "");
  if (!root || !existsSync(root)) {
    return {
      schema: PROJECT_STATE_SCHEMA,
      project_root: root,
      has_existing_code: false,
      source_file_count: 0,
      git_commit_count: 0,
    };
  }
  const sourceFileCount = countSourceFiles(root, threshold + 1);
  const commitCount = gitCommitCount(root);
  return {
    schema: PROJECT_STATE_SCHEMA,
    project_root: root,
    has_existing_code: sourceFileCount >= threshold || commitCount > 0,
    source_file_count: sourceFileCount,
    git_commit_count: commitCount,
  };
}
