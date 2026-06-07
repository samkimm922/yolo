import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const CRITICAL_TEST_FILES = [
  "__tests__/public-entrypoints.test.ts",
  "__tests__/command-registry.test.ts",
];

const SOURCE_ONLY_ALLOWLIST = [
  {
    file: "__tests__/public-entrypoints.test.ts",
    title: "converted bins call src CLI modules instead of legacy script spawner",
    pairedWith: [
      "bin ${binName} exists and parses",
      "root yolo help keeps ordinary users on the public mainline",
      "yolo run uses PI by default and runner remains available as engine-only",
    ],
  },
];

const RUNTIME_SIGNALS = [
  "spawnSync(",
  "execFileSync(",
  "runYoloCli(",
  "buildYoloCommandRegistry(",
  "listYoloCommands(",
  "getYoloCommand(",
];

const REQUIRED_RUNTIME_COVERAGE = [
  {
    file: "__tests__/public-entrypoints.test.ts",
    titles: [
      "root yolo help keeps ordinary users on the public mainline",
      "yolo run uses PI by default and runner remains available as engine-only",
    ],
    signals: ["spawnSync(", "execFileSync("],
  },
  {
    file: "__tests__/command-registry.test.ts",
    titles: [
      "public mainline excludes implementation engines from recommended commands",
      "root CLI dispatches yolo-install through the registered install handler",
    ],
    signals: ["listYoloCommands(", "getYoloCommand(", "runYoloCli("],
  },
];

function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

function extractNamedTests(relativePath) {
  const source = read(relativePath);
  const matches = [...source.matchAll(/test\((["`])([^"`]+)\1,/g)];
  return matches.map((match, index) => ({
    file: relativePath,
    title: match[2],
    body: source.slice(match.index, matches[index + 1]?.index ?? source.length),
  }));
}

function isSourceGrepOnly(block) {
  const readsSource = /\bsource\s*=\s*readFileSync\(/.test(block.body);
  const grepsSource = /assert\.(?:match|doesNotMatch)\(\s*source\s*,/.test(block.body);
  const executesRuntime = RUNTIME_SIGNALS.some((signal) => block.body.includes(signal));
  return readsSource && grepsSource && !executesRuntime;
}

describe("meta gate: critical tests are not source-grep theater", () => {
  test("source-grep-only tests require an explicit paired runtime exemption", () => {
    const sourceOnly = CRITICAL_TEST_FILES
      .flatMap(extractNamedTests)
      .filter(isSourceGrepOnly)
      .map(({ file, title }) => ({ file, title }));

    assert.deepEqual(sourceOnly, SOURCE_ONLY_ALLOWLIST.map(({ file, title }) => ({ file, title })));
    for (const item of SOURCE_ONLY_ALLOWLIST) {
      assert.ok(item.pairedWith.length > 0, `${item.title} needs a paired runtime test`);
      const titles = extractNamedTests(item.file).map((block) => block.title);
      for (const pairedTitle of item.pairedWith) {
        assert.equal(titles.includes(pairedTitle), true, `${item.title} paired test missing: ${pairedTitle}`);
      }
    }
  });

  test("public entrypoint and registry gates retain runtime/API execution signals", () => {
    for (const check of REQUIRED_RUNTIME_COVERAGE) {
      const source = read(check.file);
      for (const title of check.titles) assert.equal(source.includes(`test("${title}"`), true, `${check.file} missing ${title}`);
      for (const signal of check.signals) assert.equal(source.includes(signal), true, `${check.file} missing ${signal}`);
    }
  });
});
