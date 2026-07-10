import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isWithin, resolveWithinRoot } from "../../lib/security/path-guard.js";
import { appendJsonlRecord, readLedgerJsonl, validateLedgerChain } from "./ledger.js";

type DigestByPath = Record<string, unknown>;

interface ArtifactIntegrityOptions {
  rootDir?: unknown;
  root_dir?: unknown;
  expectedSha256?: unknown;
  expected_sha256?: unknown;
  expectedSha256ByPath?: unknown;
  expected_sha256_by_path?: unknown;
  stateRoot?: unknown;
  state_root?: unknown;
  source?: unknown;
  allowUnsignedDevelopment?: unknown;
  allow_unsigned_development?: unknown;
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

export interface RegisteredArtifactDigestsResult {
  status: "pass" | "unverifiable";
  registered_count: number;
  expected_sha256_by_path: Record<string, string>;
  errors: unknown[];
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
  const issue = expectedSha256 ? undefined : "expected_digest_missing";
  return {
    path: displayPath,
    absolute_path: resolved,
    exists: true,
    bytes: stat.size,
    sha256,
    expected_sha256: expectedSha256 || null,
    digest_match: expectedSha256 ? sha256 === expectedSha256 : null,
    ...(issue ? { issue } : {}),
  };
}

export function verifyArtifactIntegrity(paths: unknown[] = [], options: ArtifactIntegrityOptions = Object()) {
  const uniquePaths = [...new Set(asArray(paths).map(clean).filter(Boolean))];
  const artifacts = uniquePaths.map((path) => artifactIntegrityRecord(path, options));
  const missing = artifacts.filter((artifact) => artifact.exists !== true);
  const digestMismatches = artifacts.filter((artifact) => artifact.exists === true && artifact.digest_match === false);
  const unverified = artifacts.filter((artifact) => artifact.exists === true && artifact.digest_match === null);
  return {
    status: missing.length > 0 || digestMismatches.length > 0 || unverified.length > 0 ? "fail" : "pass",
    checked_count: artifacts.length,
    artifacts,
    missing,
    digest_mismatches: digestMismatches,
    unverified,
  };
}

export function registerGeneratedArtifactIntegrity(paths: unknown[] = [], options: ArtifactIntegrityOptions = Object()) {
  const rootDir = resolve(String(options.rootDir || options.root_dir || process.cwd()));
  const expectedSha256ByPath: Record<string, string> = {};
  for (const path of [...new Set(asArray(paths).map(clean).filter(Boolean))]) {
    const record = artifactIntegrityRecord(path, { rootDir });
    if (record.exists === true && typeof record.sha256 === "string") expectedSha256ByPath[path] = record.sha256;
  }
  const integrity = verifyArtifactIntegrity(paths, { ...options, rootDir, expectedSha256ByPath });
  const stateRoot = clean(options.stateRoot || options.state_root);
  if (stateRoot && integrity.status === "pass") {
    appendJsonlRecord(join(resolve(stateRoot), "state", "artifacts.jsonl"), {
      event: "artifact.digest.registered",
      ledger: "artifact",
      source: clean(options.source) || "generated-artifact",
      artifact_integrity: integrity,
    }, {
      stateRoot: resolve(stateRoot),
      allowUnsignedDevelopment: options.allowUnsignedDevelopment === true || options.allow_unsigned_development === true,
    });
  }
  return integrity;
}

export function readRegisteredArtifactDigests(paths: unknown[] = [], options: ArtifactIntegrityOptions = Object()): RegisteredArtifactDigestsResult {
  const rootDir = resolve(String(options.rootDir || options.root_dir || process.cwd()));
  const stateRoot = clean(options.stateRoot || options.state_root);
  const requestedPaths = [...new Set(asArray(paths).map(clean).filter(Boolean))];
  const expectedSha256ByPath: Record<string, string> = {};
  if (!stateRoot) {
    return {
      status: "unverifiable",
      registered_count: 0,
      expected_sha256_by_path: expectedSha256ByPath,
      errors: [{ code: "ARTIFACT_DIGEST_REGISTRY_STATE_ROOT_MISSING" }],
    };
  }
  const ledgerPath = join(resolve(stateRoot), "state", "artifacts.jsonl");
  if (!existsSync(ledgerPath)) {
    return {
      status: "unverifiable",
      registered_count: 0,
      expected_sha256_by_path: expectedSha256ByPath,
      errors: [{ code: "ARTIFACT_DIGEST_REGISTRY_MISSING", ledger_path: ledgerPath }],
    };
  }
  const records = readLedgerJsonl(ledgerPath);
  const validation = validateLedgerChain(records, {
    stateRoot: resolve(stateRoot),
    allowUnsignedDevelopment: options.allowUnsignedDevelopment === true || options.allow_unsigned_development === true,
  });
  if (!validation.ok) {
    return {
      status: "unverifiable",
      registered_count: 0,
      expected_sha256_by_path: expectedSha256ByPath,
      errors: validation.errors,
    };
  }

  const digestByAbsolutePath = new Map<string, string>();
  for (const record of records) {
    if (record.event !== "artifact.digest.registered") continue;
    const integrity = record.artifact_integrity;
    if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) continue;
    const artifacts = (integrity as { artifacts?: unknown }).artifacts;
    if (!Array.isArray(artifacts)) continue;
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) continue;
      const entry = artifact as { absolute_path?: unknown; sha256?: unknown; digest_match?: unknown };
      const absolutePath = clean(entry.absolute_path);
      const sha256 = clean(entry.sha256);
      if (absolutePath && /^[a-f0-9]{64}$/i.test(sha256) && entry.digest_match === true) {
        digestByAbsolutePath.set(resolve(absolutePath), sha256);
      }
    }
  }

  let registeredCount = 0;
  for (const path of requestedPaths) {
    const absolutePath = normalizePath(path, rootDir);
    const digest = digestByAbsolutePath.get(absolutePath);
    if (!digest) continue;
    registeredCount += 1;
    expectedSha256ByPath[path] = digest;
    expectedSha256ByPath[absolutePath] = digest;
  }
  return {
    status: registeredCount === requestedPaths.length ? "pass" : "unverifiable",
    registered_count: registeredCount,
    expected_sha256_by_path: expectedSha256ByPath,
    errors: [],
  };
}
