import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizePath(value) {
  const text = clean(value);
  return text ? resolve(text) : "";
}

function expectedDigestFor(path, expected = Object()) {
  const resolved = normalizePath(path);
  const candidates = [
    path,
    resolved,
    clean(path).replace(/\\/g, "/"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (expected[candidate]) return clean(expected[candidate]);
  }
  return "";
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function artifactIntegrityRecord(path, options = Object()) {
  const resolved = normalizePath(path);
  const rootDir = options.rootDir || options.root_dir || "";
  const expectedSha256 = clean(options.expectedSha256 || options.expected_sha256 || expectedDigestFor(path, options.expectedSha256ByPath || options.expected_sha256_by_path || {}));
  const displayPath = rootDir ? relative(resolve(rootDir), resolved) || "." : resolved;
  if (!resolved || !existsSync(resolved)) {
    return {
      path: displayPath,
      absolute_path: resolved,
      exists: false,
      bytes: 0,
      sha256: null,
      expected_sha256: expectedSha256 || null,
      digest_match: expectedSha256 ? false : null,
    };
  }

  const stat = statSync(resolved);
  const sha256 = sha256File(resolved);
  return {
    path: displayPath,
    absolute_path: resolved,
    exists: true,
    bytes: stat.size,
    sha256,
    expected_sha256: expectedSha256 || null,
    digest_match: expectedSha256 ? sha256 === expectedSha256 : null,
  };
}

export function verifyArtifactIntegrity(paths = [], options = Object()) {
  const uniquePaths = [...new Set(asArray(paths).map(clean).filter(Boolean))];
  const artifacts = uniquePaths.map((path) => artifactIntegrityRecord(path, options));
  const missing = artifacts.filter((artifact) => artifact.exists !== true);
  const digestMismatches = artifacts.filter((artifact) => artifact.exists === true && artifact.digest_match === false);
  return {
    status: missing.length > 0 || digestMismatches.length > 0 ? "fail" : "pass",
    checked_count: artifacts.length,
    artifacts,
    missing,
    digest_mismatches: digestMismatches,
  };
}

