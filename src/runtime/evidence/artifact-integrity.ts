import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isWithin, resolveWithinRoot } from "../../lib/security/path-guard.js";

type DigestByPath = Record<string, unknown>;

interface ArtifactIntegrityOptions {
  rootDir?: unknown;
  root_dir?: unknown;
  expectedSha256?: unknown;
  expected_sha256?: unknown;
  expectedSha256ByPath?: unknown;
  expected_sha256_by_path?: unknown;
  // M9: when true (release/ship mode), an existing artifact with NO pre-
  // registered expected digest is treated as a mismatch (unverified post-hoc
  // artifact) rather than ignored. Default false (accept-mode tolerates
  // runtime-collected artifacts that have no pre-registered digest).
  requireExpectedDigest?: unknown;
  require_expected_digest?: unknown;
}

export interface ArtifactIntegrityRecord extends Record<string, unknown> {
  path: string;
  absolute_path: string;
  exists: boolean;
  bytes: number;
  sha256: string | null;
  expected_sha256: string | null;
  digest_match: boolean | null;
  issue?: string;
  issue_detail?: string;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asDigestByPath(value: unknown): DigestByPath {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DigestByPath : {};
}

function normalizePath(value: unknown, rootDir = ""): string {
  const text = clean(value);
  if (text && rootDir) {
    const rootResolved = resolve(rootDir);
    return resolve(rootResolved, text);
  }
  return text ? resolve(text) : "";
}

function expectedDigestFor(path: unknown, expected: DigestByPath = Object(), rootDir = ""): string {
  const resolved = normalizePath(path, rootDir);
  const candidates = [
    path,
    resolved,
    clean(path).replace(/\\/g, "/"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const key = clean(candidate);
    if (expected[key]) return clean(expected[key]);
  }
  return "";
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function artifactIntegrityRecord(path: unknown, options: ArtifactIntegrityOptions = Object()): ArtifactIntegrityRecord {
  const rootDir = clean(options.rootDir || options.root_dir);
  const rootResolved = rootDir ? resolve(rootDir) : "";
  const resolved = normalizePath(path, rootResolved);
  const expectedByPath = asDigestByPath(options.expectedSha256ByPath || options.expected_sha256_by_path || {});
  const expectedSha256 = clean(options.expectedSha256 || options.expected_sha256 || expectedDigestFor(path, expectedByPath, rootResolved));
  const displayPath = rootDir ? relative(resolve(rootDir), resolved) || "." : resolved;
  if (rootResolved) {
    const guarded = resolveWithinRoot(rootResolved, path);
    if (!guarded.ok || !isWithin(resolved, rootResolved)) {
      return {
        path: displayPath,
        absolute_path: resolved,
        exists: false,
        bytes: 0,
        sha256: null,
        expected_sha256: expectedSha256 || null,
        digest_match: expectedSha256 ? false : null,
        issue: "path_escape",
        issue_detail: guarded.detail || `path resolves outside root "${rootResolved}"`,
      };
    }
  }
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

export function verifyArtifactIntegrity(paths: unknown[] = [], options: ArtifactIntegrityOptions = Object()) {
  const uniquePaths = [...new Set(asArray(paths).map(clean).filter(Boolean))];
  const artifacts = uniquePaths.map((path) => artifactIntegrityRecord(path, options));
  const missing = artifacts.filter((artifact) => artifact.exists !== true);
  // M9: in release/ship mode (requireExpectedDigest), an existing SOURCE artifact
  // with no pre-registered digest (digest_match === null) is unverified (potential
  // post-hoc append) and must fail. State/approval JSON files are not delivered
  // source, so they remain tolerated even in release mode.
  const requireExpectedDigest = options.requireExpectedDigest === true || options.require_expected_digest === true;
  const SOURCE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|py|go|rs|java|rb|php|vue|svelte)$/i;
  const digestMismatches = artifacts.filter((artifact) => {
    if (artifact.exists !== true) return false;
    if (artifact.digest_match === false) return true;
    // M9: a source file with no pre-registered digest in release mode is unverified.
    return requireExpectedDigest && artifact.digest_match === null && SOURCE_EXT.test(String(artifact.path || artifact.absolute_path || ""));
  });
  return {
    status: missing.length > 0 || digestMismatches.length > 0 ? "fail" : "pass",
    checked_count: artifacts.length,
    artifacts,
    missing,
    digest_mismatches: digestMismatches,
  };
}
