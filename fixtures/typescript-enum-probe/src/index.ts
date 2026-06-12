// Version-independence probe.
//
// `enum` is the canonical TypeScript construct that node's native
// `--experimental-strip-types` (default in node 22+) refuses to compile:
//   ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
//     TypeScript enum is not supported in strip-only mode
//
// And node 20 has no native TS support at all (.ts → ERR_UNKNOWN_FILE_EXTENSION).
//
// The only way this file runs is if a real TypeScript transpiler (tsx / esbuild)
// is on the loader path. If the harness falls back to "bare node src/index.ts"
// on any host node version, this fixture will fail with `blocked` and this
// test will catch it.
//
// See: src/fixtures/harness.ts → runCommand → buildChildEnv()
//      → NODE_OPTIONS = --import file://<yolo>/node_modules/tsx/dist/loader.mjs
export enum ProbeStatus {
  Pass = "pass",
  Blocked = "blocked",
}

export function probe(): ProbeStatus {
  return ProbeStatus.Pass;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(probe());
}
