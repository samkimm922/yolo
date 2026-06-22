/**
 * typecheck-sdk.ts — orchestrates the public SDK boundary type gate.
 *
 * The repo-wide tsconfig is intentionally non-strict (strict:false), which lets
 * SDK type breakage slip into published `.d.ts` files unnoticed. This script
 * runs TWO complementary strict checks against the SDK boundary only, without
 * turning on strict mode for the whole codebase (which would surface thousands
 * of unrelated internal errors and is explicitly out of scope):
 *
 *   1. SOURCE GATE — strict-checks `sdk.ts` itself. Internal modules imported
 *      by sdk.ts carry their own (out-of-scope) strict errors, so this gate
 *      filters the compiler output to `sdk.ts` errors only. Those are the
 *      boundary defects this gate owns: implicit-any params, unsafe casts, and
 *      missing types on the SDK entry point and its exported option interfaces.
 *
 *   2. CONTRACT GATE — builds the package (refreshing dist/*.d.ts) and
 *      compiles `__tests__/sdk-types.test-d.ts` under strict mode against the
 *      published `dist/sdk.d.ts`. This catches regressions that drop or widen
 *      a public export, since the consumer-style assertions fail to compile.
 *
 * Exit non-zero if either gate reports a defect.
 */
import { execSync } from "node:child_process";
import { exit } from "node:process";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

/** Run a command and return its combined stdout/stderr as a string. */
function run(command: string): string {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    return `${output.stdout ?? ""}${output.stderr ?? ""}`;
  }
}

/** Lines from tsc output that are real sdk.ts boundary errors. */
function extractSdkErrors(rawOutput: string): string[] {
  return rawOutput
    .split("\n")
    .filter((line) => /^sdk\.ts\(\d+,\d+\): error TS\d+:/.test(line));
}

let failed = false;

// ---------------------------------------------------------------------------
// Gate 1: source-level strict check of sdk.ts (filter to sdk.ts errors only).
// ---------------------------------------------------------------------------
log(`${BOLD}[typecheck:sdk] gate 1/2 — strict source check of sdk.ts${RESET}`);
const sourceOutput = run("npx tsc -p tsconfig.sdk.json --noEmit");
const sdkSourceErrors = extractSdkErrors(sourceOutput);
if (sdkSourceErrors.length > 0) {
  failed = true;
  log(`${RED}✗ sdk.ts boundary errors (${sdkSourceErrors.length}):${RESET}`);
  for (const line of sdkSourceErrors) {
    log(`${RED}  ${line}${RESET}`);
  }
  log(
    `${RED}  Internal modules imported by sdk.ts may also report strict errors;${RESET}\n` +
      `${RED}  those are out of scope and filtered out. Only sdk.ts defects fail this gate.${RESET}`,
  );
} else {
  log(`${GREEN}✓ sdk.ts strict source check passed${RESET}`);
}

// ---------------------------------------------------------------------------
// Gate 2: rebuild the published .d.ts and compile the consumer type test.
// ---------------------------------------------------------------------------
log(`${BOLD}[typecheck:sdk] gate 2/2 — rebuild dist + consumer type-test contract${RESET}`);
const buildOutput = run("npm run build --silent");
if (/Found \d+ error/.test(buildOutput) && !/0 error/.test(buildOutput)) {
  failed = true;
  log(`${RED}✗ build failed, cannot run contract gate${RESET}`);
  log(buildOutput);
} else {
  const contractOutput = run("npx tsc -p tsconfig.sdk.test.json --noEmit");
  const contractErrors = contractOutput
    .split("\n")
    .filter((line) => /error TS\d+:/.test(line));
  if (contractErrors.length > 0) {
    failed = true;
    log(`${RED}✗ consumer contract type errors (${contractErrors.length}):${RESET}`);
    for (const line of contractErrors) {
      log(`${RED}  ${line}${RESET}`);
    }
  } else {
    log(`${GREEN}✓ consumer contract type-test passed${RESET}`);
  }
}

if (failed) {
  log(`${RED}${BOLD}[typecheck:sdk] FAILED — public SDK boundary has type defects${RESET}`);
  exit(1);
}
log(`${GREEN}${BOLD}[typecheck:sdk] PASSED — public SDK boundary is type-clean${RESET}`);
exit(0);
