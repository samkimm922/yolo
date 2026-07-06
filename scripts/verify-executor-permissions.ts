#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProviderInvocation,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  DEFAULT_CLAUDE_SETTINGS_FILE,
  YOLO_PACKAGE_ROOT,
} from "../src/runtime/execution/provider-adapter.js";

const TIMEOUT_MS = Number(process.env.YOLO_VERIFY_EXECUTOR_TIMEOUT_MS || 120000);
const MODEL = process.env.YOLO_VERIFY_EXECUTOR_MODEL || "claude-sonnet-4-6";
const MAX_BUFFER = 10 * 1024 * 1024;
const OUTPUT_ARGS = ["--output-format", "stream-json", "--verbose", "--include-hook-events", "--no-session-persistence"];

function tail(value: unknown, max = 4000) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(-max) : text;
}

function parseEvents(output: unknown) {
  return String(output ?? "").split(/\r?\n/).flatMap((line) => {
    try {
      return line.trim().startsWith("{") ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

function eventText(event: any) {
  const parts = [event.result, event.output, event.stdout, event.stderr].filter((item) => typeof item === "string");
  for (const item of event.message?.content || []) {
    if (typeof item?.text === "string") parts.push(item.text);
    if (item?.type === "tool_use") parts.push(`${item.name || "tool"} ${JSON.stringify(item.input || {})}`);
    if (item?.type === "tool_result" && typeof item.content === "string") parts.push(item.content);
  }
  return parts.join("\n");
}

function claudeInvocation(workDir: string) {
  return buildProviderInvocation({
    provider: "claude",
    config: { ai: { executor: "claude", model: MODEL, settings: DEFAULT_CLAUDE_SETTINGS_FILE, claude_permission_mode: DEFAULT_CLAUDE_PERMISSION_MODE } },
    workDir,
    rootDir: workDir,
    runtimeDir: join(workDir, ".yolo", "state", "runtime"),
    packageRoot: YOLO_PACKAGE_ROOT,
  });
}

function runCheck(name: string, command: string, workDir: string) {
  const invocation = claudeInvocation(workDir);
  const prompt = `Use the Bash tool exactly once to run this command:\n${command}\nReturn the command output and any error.`;
  const child = spawnSync(invocation.command, [...invocation.args, ...OUTPUT_ARGS, prompt], {
    cwd: workDir,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  const events = parseEvents(child.stdout);
  const resultEvent = events.find((event) => event.type === "result") || {};
  return {
    name,
    command: invocation.command,
    args_summary: {
      model: MODEL,
      permission_mode: DEFAULT_CLAUDE_PERMISSION_MODE,
      settings: DEFAULT_CLAUDE_SETTINGS_FILE,
      output_format: "stream-json",
      include_hook_events: true,
    },
    exit_code: child.status,
    timed_out: child.error && "code" in child.error ? child.error.code === "ETIMEDOUT" : false,
    error: child.error?.message || null,
    result: {
      subtype: resultEvent.subtype || null,
      is_error: resultEvent.is_error ?? null,
      terminal_reason: resultEvent.terminal_reason || null,
      result: resultEvent.result || null,
      permission_denials: resultEvent.permission_denials || [],
    },
    event_summary: {
      total: events.length,
      hook_events: events.filter((event) => event.type === "system" && String(event.subtype || "").startsWith("hook_")).length,
      assistant_events: events.filter((event) => event.type === "assistant").length,
      api_retries: events.filter((event) => event.type === "system" && event.subtype === "api_retry").length,
    },
    combined_text_tail: tail(events.map(eventText).filter(Boolean).join("\n")),
  };
}

function main() {
  const workDir = mkdtempSync(join(tmpdir(), "yolo-verify-executor-"));
  const nonce = `yolo-nonce-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const yoloProbe = join(workDir, ".yolo", "state", "executor-permission-probe.txt");
  writeFileSync(join(workDir, "nonce.txt"), `${nonce}\n`, "utf8");
  try {
    const nonceRun = runCheck("bash_nonce_read", "cat nonce.txt", workDir);
    const npmRun = runCheck("bash_npm_ping", "npm ping >/dev/null && echo YOLO_NPM_PING_OK", workDir);
    const yoloRun = runCheck(
      "yolo_state_write_blocked",
      "mkdir -p .yolo/state && printf SHOULD_NOT_EXIST > .yolo/state/executor-permission-probe.txt && echo YOLO_YOLO_WRITE_CREATED",
      workDir,
    );
    const probeExists = existsSync(yoloProbe);
    const checks = [
      { ...nonceRun, passed: nonceRun.exit_code === 0 && nonceRun.combined_text_tail.includes(nonce), expected: "Bash can read a local nonce file and return its contents." },
      { ...npmRun, passed: npmRun.exit_code === 0 && npmRun.combined_text_tail.includes("YOLO_NPM_PING_OK"), expected: "Network Bash can reach npm ping and print YOLO_NPM_PING_OK." },
      {
        ...yoloRun,
        passed: !probeExists && /YOLO_STATE_BASH_WRITE_BLOCKED|YOLO_STATE_DIRECT_WRITE_BLOCKED|Direct (Bash access|LLM write) to \.yolo state is blocked|blocked by hook/i.test(yoloRun.combined_text_tail),
        expected: ".yolo/state write attempt is intercepted by the hook and the probe file does not exist.",
        probe_file: yoloProbe,
        probe_file_exists: probeExists,
      },
    ];
    const report = {
      schema: "yolo.executor_permissions.verify.v1",
      passed: checks.every((check) => check.passed),
      work_dir: workDir,
      settings: { source: DEFAULT_CLAUDE_SETTINGS_FILE, package_root: YOLO_PACKAGE_ROOT, permission_mode: DEFAULT_CLAUDE_PERMISSION_MODE },
      checks,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
