// CLI argument-parsing helpers shared across yolo subcommand parsers.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

export function cliParseError(name) {
  return Object.assign(new Error(`${name} requires a value.`), {
    name: "YoloCliParseError",
    code: "CLI_PARSE_ERROR",
    flag: name,
    exit_code: 2,
  });
}

// Collect unknown `--*` arguments during parsing. The first unknown flag is
// recorded as the primary `flag`, but every unknown flag is surfaced in
// `unknown_flags` so the user can fix them all in one pass. Unknown flags
// must never be silently dropped: a typo like `--prd-path` would otherwise
// fall through to a misleading "missing PRD path" / "missing requirement"
// error and send the user (especially a non-technical one) down the wrong path.
// Each entry is expected to already be the normalized bare flag (e.g. `--foo`).
export function throwUnknownFlags(unknownFlags) {
  if (!unknownFlags.length) return;
  const unique = Array.from(new Set(unknownFlags));
  throw Object.assign(new Error(`Unknown flag: ${unique.join(", ")}.`), {
    name: "YoloCliParseError",
    code: "CLI_UNKNOWN_FLAG",
    flag: unique[0],
    unknown_flags: unique,
    exit_code: 2,
  });
}

export function isCliParseError(error) {
  return error?.name === "YoloCliParseError" || error?.code === "CLI_PARSE_ERROR" || error?.code === "CLI_UNKNOWN_FLAG";
}

export function cliParseErrorResult(error, command = "yolo") {
  const isUnknownFlag = error?.code === "CLI_UNKNOWN_FLAG";
  const unknownFlags = Array.from(new Set(error.unknown_flags || (error.flag ? [error.flag] : [])));
  return {
    schema: "yolo.cli.parse_error.v1",
    status: "error",
    code: error.code || "CLI_PARSE_ERROR",
    command,
    flag: error.flag || null,
    unknown_flags: unknownFlags.length ? unknownFlags : null,
    summary: error.message || "CLI argument parse error.",
    exit_code: error.exit_code || 2,
    next_actions: isUnknownFlag
      ? [`Remove ${unknownFlags.join(", ")} or check the spelling with \`yolo --help\`.`]
      : error.flag
        ? [`Provide a value for ${error.flag}, or remove that flag.`]
        : ["Fix the CLI arguments and rerun the command."],
  };
}

export function emitCliParseError(error, argv = [], io = Object(), command = "yolo") {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const result = cliParseErrorResult(error, command);
  if (argv.includes("--json")) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stderr.write(`${result.summary}\n${result.next_actions.join("\n")}\n`);
  return result.exit_code;
}

export function readArgValue(argv, index, name) {
  const arg = argv[index];
  if (arg.includes("=")) {
    const value = arg.split("=").slice(1).join("=");
    if (!value) throw cliParseError(name);
    return { value, consumed: 0 };
  }
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) throw cliParseError(name);
  return { value: next, consumed: 1 };
}

export function readOptionalBooleanArgValue(argv, index, name) {
  const arg = argv[index];
  if (arg.includes("=")) {
    const value = arg.split("=").slice(1).join("=");
    if (!value) throw cliParseError(name);
    return { value, consumed: 0 };
  }
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) return { value: "true", consumed: 0 };
  return { value: next, consumed: 1 };
}
