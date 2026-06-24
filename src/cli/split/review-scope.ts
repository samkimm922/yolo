// Review-scope file collection helpers for the yolo review command.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writeLifecycleStageReport } from "../../lifecycle/progress.js";
import { cleanCliText } from "./shared.js";

const REVIEW_SCOPE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

// Minimal structural type for a review scan result. Only the fields read by
// buildScopedReviewScanReport are described; everything else passes through.
type ReviewFinding = {
  severity?: string;
  must_fix_before_ship?: boolean;
};

type ReviewScan = {
  findings: ReviewFinding[];
  total_findings: number;
};

type ReviewScopeInput = {
  target_files?: unknown[];
  objectiveParts?: unknown[];
};

type ScopedReviewReport = {
  status: string;
  summary: string;
  project_root: string;
  review_scope: string[];
  artifacts: string[];
  next_actions: string[];
  scan: ReviewScan;
  findings: ReviewFinding[];
  lifecycle_write?: { artifact_path: string } | null;
  [key: string]: unknown;
};

export function splitCliListValues(values: unknown[] = []) {
  return values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function projectRelativePath(projectRoot: string, path: string) {
  const rel = relative(projectRoot, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll("\\", "/") : path;
}

export function looksLikeReviewScope(value: unknown, projectRoot: string) {
  const clean = cleanCliText(value);
  if (!clean) return false;
  if (existsSync(resolve(projectRoot, clean))) return true;
  return /(^\.{1,2}[\\/]|[\\/]|\.([cm]?[jt]sx?|json|md|css|scss|html)$)/i.test(clean);
}

export function collectReviewScopeFiles(projectRoot: string, path: string): string[] {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  if (!existsSync(absolutePath)) return [projectRelativePath(projectRoot, absolutePath)];
  const stat = statSync(absolutePath);
  if (stat.isFile()) return [projectRelativePath(projectRoot, absolutePath)];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const child = join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectReviewScopeFiles(projectRoot, child));
    } else if (REVIEW_SCOPE_EXTENSIONS.has(entry.name.match(/\.[^.]+$/)?.[0] || "")) {
      files.push(projectRelativePath(projectRoot, child));
    }
  }
  return files;
}

export function reviewScopeFilesFromInput(input: ReviewScopeInput = {}, projectRoot: string) {
  const explicit = splitCliListValues(input.target_files || []);
  const positional = (input.objectiveParts || []).filter((part) => looksLikeReviewScope(part, projectRoot));
  const seen = new Set<string>();
  const files: string[] = [];
  for (const item of [...explicit, ...positional]) {
    const itemPath = String(item);
    for (const file of collectReviewScopeFiles(projectRoot, itemPath)) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

export function buildScopedReviewScanReport({ scan, projectRoot, stateRoot, reviewScopeFiles, writeLifecycle }: {
  scan: ReviewScan;
  projectRoot: string;
  stateRoot: string;
  reviewScopeFiles: string[];
  writeLifecycle?: boolean;
}): ScopedReviewReport {
  const hasHigh = scan.findings.some((finding) =>
    finding.severity === "HIGH" || finding.severity === "CRITICAL" || finding.must_fix_before_ship === true
  );
  const report = Object.assign(Object(), {
    status: hasHigh ? "warning" : "success",
    summary: `Review scan found ${scan.total_findings} finding(s).`,
    project_root: projectRoot,
    review_scope: reviewScopeFiles,
    artifacts: [],
    next_actions: hasHigh ? ["Review HIGH/CRITICAL findings before shipping."] : [],
    scan,
    findings: scan.findings,
  }) as ScopedReviewReport;
  if (writeLifecycle !== false && stateRoot) {
    report.lifecycle_write = writeLifecycleStageReport("review-fix", report, {
      projectRoot,
      stateRoot,
      source: "yolo-review",
      learnFailures: true,
      skipSequenceCheck: true,
    });
    report.artifacts.push(report.lifecycle_write.artifact_path);
  }
  return report;
}
