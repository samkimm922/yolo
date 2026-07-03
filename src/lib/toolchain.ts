import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { parseCommandToArgv } from "./security/command-guard.js";
import { commandExistsSync } from "./security/safe-exec.js";
import { loadConfig } from "./config.js";

export type BuildCommandKind = "test" | "type_check" | "build" | "lint" | "dead_code";
export type PackageManager = "pnpm" | "yarn" | "npm";

export const DEFAULT_EXECUTOR_TIMEOUT_MS = 600000;
export const DEFAULT_GATE_TIMEOUT_MS: Record<BuildCommandKind, number> = {
  type_check: 120000,
  lint: 90000,
  dead_code: 30000,
  test: 120000,
  build: 240000,
};

const BUILD_CONFIG_KEYS: Record<BuildCommandKind, string> = {
  test: "test",
  type_check: "type_check",
  build: "build",
  lint: "lint",
  dead_code: "dead_code",
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function configBuild(config: Record<string, unknown> = Object()): Record<string, unknown> {
  const build = config.build;
  return build && typeof build === "object" && !Array.isArray(build)
    ? build as Record<string, unknown>
    : Object();
}

export function buildConfigKey(kind: BuildCommandKind): string {
  return `config.build.${BUILD_CONFIG_KEYS[kind]}`;
}

export function detectPackageManager(projectRoot = process.cwd()): PackageManager {
  const root = resolve(projectRoot || process.cwd());
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

function defaultBuildCommand(kind: BuildCommandKind, projectRoot: string): string {
  const pm = detectPackageManager(projectRoot);
  if (kind === "test") return `${pm} test`;
  if (kind === "type_check") return `${pm} run typecheck`;
  if (kind === "build") return `${pm} run build`;
  return "";
}

export function resolveBuildCommand(kind: BuildCommandKind, config: Record<string, unknown> = Object(), projectRoot = process.cwd()): string {
  const configured = clean(configBuild(config)[BUILD_CONFIG_KEYS[kind]]);
  return configured || defaultBuildCommand(kind, projectRoot);
}

export function buildCommandEnv(projectRoot: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const localBin = join(resolve(projectRoot || process.cwd()), "node_modules", ".bin");
  return {
    ...baseEnv,
    PATH: [localBin, baseEnv.PATH || ""].filter(Boolean).join(delimiter),
  };
}

function executableExistsInProject(executable: string, projectRoot: string, commandExists: (command: string) => boolean): boolean {
  if (!executable) return false;
  const root = resolve(projectRoot || process.cwd());
  if (executable.includes("/") || (process.platform === "win32" && executable.includes("\\"))) {
    const candidate = isAbsolute(executable) ? executable : resolve(root, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  try {
    accessSync(join(root, "node_modules", ".bin", executable), constants.X_OK);
    return true;
  } catch {
    return commandExists(executable);
  }
}

export type BuildCommandAvailability = {
  ok: boolean;
  command: string;
  executable: string;
  configKey: string;
  message: string;
};

export function missingBuildCommandMessage(executable: string, configKey: string): string {
  return `缺少命令 "${executable}"，请在 ${configKey} 配置目标项目可用命令。`;
}

export function assertBuildCommandAvailable(
  kind: BuildCommandKind,
  config: Record<string, unknown> = Object(),
  projectRoot = process.cwd(),
  options: { commandExists?: (command: string) => boolean } = Object(),
): BuildCommandAvailability {
  const command = resolveBuildCommand(kind, config, projectRoot);
  const configKey = buildConfigKey(kind);
  const parsed = parseCommandToArgv(command);
  if (!command) {
    const executable = kind === "lint" ? "eslint" : kind;
    return {
      ok: false,
      command,
      executable,
      configKey,
      message: missingBuildCommandMessage(executable, configKey),
    };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      command,
      executable: "",
      configKey,
      message: `command rejected: ${parsed.detail}；请在 ${configKey} 配置可执行命令。`,
    };
  }
  const executable = parsed.argv?.[0] || "";
  const exists = executableExistsInProject(executable, projectRoot, options.commandExists || commandExistsSync);
  return {
    ok: exists,
    command,
    executable,
    configKey,
    message: exists ? "" : missingBuildCommandMessage(executable, configKey),
  };
}

export function commandUnavailableDetail(kind: BuildCommandKind, command: string, projectRoot = process.cwd()): string {
  const parsed = parseCommandToArgv(command);
  const executable = parsed.ok ? parsed.argv?.[0] || command.split(/\s+/)[0] || "" : command.split(/\s+/)[0] || "";
  return missingBuildCommandMessage(executable, buildConfigKey(kind));
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveGateTimeout(kind: BuildCommandKind, config: Record<string, unknown> = Object(), fallback = DEFAULT_GATE_TIMEOUT_MS[kind]): number {
  const gate = config.gate as Record<string, unknown> | undefined;
  const timeout = gate?.timeout as Record<string, unknown> | undefined;
  return positiveNumber(timeout?.[BUILD_CONFIG_KEYS[kind]], fallback);
}

export function resolveExecutorTimeoutMs(config: Record<string, unknown> = Object(), fallback = DEFAULT_EXECUTOR_TIMEOUT_MS): number {
  const executor = config.executor as Record<string, unknown> | undefined;
  const ai = config.ai as Record<string, unknown> | undefined;
  return positiveNumber(executor?.timeout_ms ?? executor?.timeoutMs ?? ai?.timeout_ms ?? ai?.timeoutMs, fallback);
}

export function loadProjectToolchainConfig(projectRoot = process.cwd(), options: { config?: unknown; configPath?: string } = Object()): Record<string, unknown> {
  if (options.config && typeof options.config === "object") return options.config as Record<string, unknown>;
  if (options.configPath) return loadConfig({ path: options.configPath, forceReload: true }) as Record<string, unknown>;
  const root = resolve(projectRoot || process.cwd());
  const projectConfig = join(root, ".yolo", "config.json");
  if (existsSync(projectConfig)) return loadConfig({ path: projectConfig, forceReload: true }) as Record<string, unknown>;
  return loadConfig({ forceReload: true }) as Record<string, unknown>;
}
