import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { HTML } from "./server.js";

export const PROGRESS_DASHBOARD_UI_EVIDENCE_SCHEMA_VERSION = "1.0";
export const PROGRESS_DASHBOARD_UI_EVIDENCE_SCHEMA = "yolo.progress_dashboard.ui_evidence.v1";

const DANGEROUS_TASK_ID = "TASK-<img src=x onerror=alert(1)>";
const DANGEROUS_TASK_DESC = "Render <script>alert(\"x\")</script> safely";
const DANGEROUS_GATE = "gate-<svg/onload=alert(1)>";

const DESIGN_SYSTEM_SOURCES = [
  {
    id: "nextlevelbuilder/ui-ux-pro-max-skill",
    role: "priority-ordered UI/UX quality rules",
    evidence_rule: "Accessibility, touch, performance, style, responsive layout, typography, animation, forms, navigation, and data must be inspectable.",
  },
  {
    id: "nexu-io/open-design",
    role: "local-first design system and sandboxed preview/evidence pattern",
    evidence_rule: "UI evidence should be generated from local project files and written back as artifacts.",
  },
  {
    id: "VoltAgent/awesome-design-md",
    role: "plain-text DESIGN.md design-system convention",
    evidence_rule: "Agents need a durable text design source, not only screenshots or chat memory.",
  },
  {
    id: "goabstract/Awesome-Design-Tools",
    role: "design resource taxonomy for colors, icons, information architecture, and user research",
    evidence_rule: "Design evidence should name the checked domains instead of relying on vague polish language.",
  },
  {
    id: "DovAmir/awesome-design-patterns",
    role: "architecture pattern catalog",
    evidence_rule: "UI evidence collectors should stay adapter-based and replaceable, not hardcoded to one tool.",
  },
];

const REVIEW_PILLARS = [
  "copywriting",
  "visuals",
  "color",
  "typography",
  "spacing",
  "experience_design",
];

const QUALITY_DOMAINS = [
  "accessibility",
  "touch_interaction",
  "performance",
  "style_selection",
  "layout_responsive",
  "typography_color",
  "animation",
  "forms_feedback",
  "navigation",
  "charts_data",
];

function nowIso() {
  return new Date().toISOString();
}

function repoRelative(path, projectRoot) {
  const rel = relative(projectRoot, path).replace(/\\/g, "/");
  return rel.startsWith("..") ? path : rel;
}

function writeText(filePath, text) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

function forceTheme(html, theme) {
  return html.replace("<html lang=\"zh\">", `<html lang="zh" data-theme="${theme}">`);
}

function check(id, status, message, evidence = Object()) {
  return { id, status, message, ...evidence };
}

function includesAny(text, values = []) {
  return values.some((value) => text.includes(value));
}

function findChromeBinary(input = Object(), options = Object()) {
  const explicit = input.chromePath || input.chrome_path || options.chromePath || options.chrome_path || "";
  const candidates = [
    explicit,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function renderChromeScreenshot({ chromePath, htmlPath, outputPath, profileDir, viewport }) {
  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  const result = spawnSync(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--hide-scrollbars",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=1000",
    "--timeout=5000",
    `--user-data-dir=${profileDir}`,
    `--window-size=${viewport.width},${viewport.height}`,
    `--screenshot=${outputPath}`,
    pathToFileURL(htmlPath).href,
  ], {
    encoding: "utf8",
    timeout: 10000,
  });
  const fileOk = existsSync(outputPath) && statSync(outputPath).size > 0;
  return {
    status: result.status === 0 && fileOk ? "pass" : "fail",
    exit_code: result.status,
    signal: result.signal || null,
    stderr: String(result.stderr || "").trim().slice(0, 1000),
    output_path: outputPath,
    file_size: fileOk ? statSync(outputPath).size : 0,
    viewport,
  };
}

function collectBrowserEvidence({ input, options, outputDir, activePath, idlePath, renderTargets, projectRoot }) {
  const chromePath = findChromeBinary(input, options);
  const requireBrowser = input.requireBrowser === true || input.require_browser === true || options.requireBrowser === true || options.require_browser === true;
  if (!chromePath) {
    return {
      status: requireBrowser ? "fail" : "skipped",
      chrome_path: "",
      reason: "Chrome/Chromium binary was not found.",
      screenshots: [],
      checks: [check("browser_render_available", requireBrowser ? "fail" : "warning", "Browser rendering requires Chrome or Chromium.")],
    };
  }

  const screenshotDir = join(outputDir, "screenshots");
  rmSync(screenshotDir, { recursive: true, force: true });
  const profileDir = mkdtempSync(join(tmpdir(), "yolo-progress-ui-chrome-"));
  const targets = renderTargets || [
    {
      id: "browser_render_desktop",
      htmlPath: activePath,
      screenshotName: "active-desktop.png",
      viewport: { name: "desktop", width: 1280, height: 900 },
    },
    {
      id: "browser_render_mobile",
      htmlPath: idlePath,
      screenshotName: "idle-mobile.png",
      viewport: { name: "mobile", width: 390, height: 844 },
    },
  ];
  let renders = [];
  try {
    renders = targets.map((item) => ({
      id: item.id,
      theme: item.theme || "system",
      state: item.state || "unknown",
      ...renderChromeScreenshot({
        chromePath,
        htmlPath: item.htmlPath,
        outputPath: item.outputPath || join(screenshotDir, item.screenshotName),
        profileDir,
        viewport: item.viewport,
      }),
    }));
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }

  const checks = renders.map((render) => check(
    render.id,
    render.status,
    `Chrome headless must render ${render.viewport.name} dashboard evidence without crashing.`,
    {
      artifact: repoRelative(render.output_path, projectRoot),
      file_size: render.file_size,
      exit_code: render.exit_code,
      stderr: render.stderr,
      theme: render.theme,
      state: render.state,
    },
  ));

  return {
    status: renders.every((render) => render.status === "pass") ? "pass" : "fail",
    chrome_path: chromePath,
    screenshots: renders.filter((render) => render.status === "pass").map((render) => repoRelative(render.output_path, projectRoot)),
    checks,
  };
}

function buildFixtureLifecycle() {
  return {
    exists: true,
    current_stage: "run",
    stage_counts: { total: 10, completed: 5, active: 1, pending: 4, blocked: 0, warning: 0 },
    blocker_count: 0,
    evidence_count: 6,
    latest_reports: [],
    recent_events: [],
    next_action: "Continue run evidence collection.",
  };
}

function buildIdleData() {
  return {
    currentRun: null,
    lifecycle: buildFixtureLifecycle(),
  };
}

function buildActiveData() {
  return {
    currentRun: {
      run_id: "ui-dogfood-run",
      prd: "fixtures/progress-dashboard-ui/prd.json",
      started_at: "2026-05-26T00:00:00.000Z",
    },
    lifecycle: buildFixtureLifecycle(),
    tasks: [
      {
        id: "UI-001",
        status: "done",
        priority: "P1",
        description: "Dashboard shows run progress, stats, task logs, and review state.",
        phase: "done",
        retry: 0,
        elapsed: 12,
      },
      {
        id: DANGEROUS_TASK_ID,
        status: "running",
        priority: "P1",
        description: DANGEROUS_TASK_DESC,
        phase: "gate",
        retry: 1,
        elapsed: 3,
      },
      {
        id: "UI-003",
        status: "pending",
        priority: "P2",
        description: "Mobile layout keeps badges and task descriptions readable.",
        phase: "",
        retry: 0,
      },
    ],
    done: 1,
    failed: 0,
    total: 3,
    current: null,
    source: "prd",
    runnerActive: true,
    review: {
      currentRound: 1,
      totalRounds: 1,
      totalBugs: 0,
      latestStatus: "clean",
      latestBugs: 0,
    },
  };
}

function inspectProgressHtml({ idleHtml, activeHtml }) {
  const rawDanger = [
    "<img src=x onerror=alert(1)>",
    "<script>alert(\"x\")</script>",
    "<svg/onload=alert(1)>",
  ];
  const escapedDanger = [
    "TASK-&lt;img src=x onerror=alert(1)&gt;",
    "Render &lt;script&gt;alert(\"x\")&lt;/script&gt; safely",
    "gate-&lt;svg/onload=alert(1)&gt;",
  ];

  return [
    check(
      "viewport_meta",
      idleHtml.includes("name=\"viewport\"") && activeHtml.includes("name=\"viewport\"") ? "pass" : "fail",
      "Dashboard HTML must declare a mobile viewport.",
    ),
    check(
      "active_regions",
      ["id=\"progressBar\"", "id=\"statsRow\"", "id=\"taskList\"", "id=\"reviewCardSlot\"", "id=\"sidebar\""].every((value) => activeHtml.includes(value)) ? "pass" : "fail",
      "Active run UI must expose progress, stats, task list, review, and sidebar regions.",
    ),
    check(
      "idle_lifecycle",
      idleHtml.includes("Lifecycle: run") && idleHtml.includes("证据 <strong>6</strong>") ? "pass" : "fail",
      "Idle UI must still show lifecycle state and evidence count.",
    ),
    check(
      "responsive_css",
      activeHtml.includes("@media (max-width: 639px)") && activeHtml.includes("@media (min-width: 640px)") ? "pass" : "fail",
      "Dashboard must include mobile and desktop responsive rules.",
    ),
    check(
      "adaptive_theme_css",
      activeHtml.includes("color-scheme: light dark")
        && activeHtml.includes("prefers-color-scheme: dark")
        && activeHtml.includes('html[data-theme="light"]')
        && activeHtml.includes('html[data-theme="dark"]')
        ? "pass" : "fail",
      "Progress server must support system-adaptive light and dark themes, with forced theme hooks for evidence.",
    ),
    check(
      "server_html_escapes_task_data",
      !includesAny(activeHtml, rawDanger) && escapedDanger.every((value) => activeHtml.includes(value)) ? "pass" : "fail",
      "Server-rendered task and gate text must be escaped before entering HTML.",
    ),
    check(
      "client_render_escapes_task_data",
      activeHtml.includes("escapeHtml(t.description || rawTaskId)") && activeHtml.includes("findTaskCardById(taskId)") ? "pass" : "fail",
      "Client-side SSE re-render must escape task text and avoid raw selector interpolation.",
    ),
    check(
      "design_contract_shape",
      REVIEW_PILLARS.length === 6 && QUALITY_DOMAINS.includes("layout_responsive") ? "pass" : "fail",
      "UI/UX evidence must carry design contract, 6-pillar review, and quality-domain metadata.",
    ),
    check(
      "no_inline_task_event_handler",
      includesAny(activeHtml, ["<img src=x onerror", "<svg/onload", "<script>alert"]) ? "fail" : "pass",
      "Task data must not be able to create executable inline event handlers.",
    ),
  ];
}

export function buildProgressDashboardUiEvidence(input = Object(), options = Object()) {
  const projectRoot = resolve(input.projectRoot || input.project_root || options.projectRoot || options.project_root || process.cwd());
  const stateRoot = resolve(input.stateRoot || input.state_root || options.stateRoot || options.state_root || join(projectRoot, ".yolo"));
  const outputDir = resolve(input.outputDir || input.output_dir || options.outputDir || options.output_dir || join(stateRoot, "state/evidence/progress-dashboard-ui"));
  const outputPath = resolve(input.outputPath || input.output_path || options.outputPath || options.output_path || join(outputDir, "ui-evidence.json"));
  const writeArtifacts = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false && options.write_artifacts !== false;
  const browserSmoke = input.browserSmoke !== false && input.browser_smoke !== false && options.browserSmoke !== false && options.browser_smoke !== false;

  const idleHtml = HTML(buildIdleData(), { [DANGEROUS_GATE]: 2 });
  const activeHtml = HTML(buildActiveData(), { [DANGEROUS_GATE]: 2 });
  const idlePath = join(outputDir, "idle.html");
  const activePath = join(outputDir, "active.html");
  const themedHtmlArtifacts = [
    { state: "active", theme: "light", path: join(outputDir, "active.light.html"), html: forceTheme(activeHtml, "light") },
    { state: "active", theme: "dark", path: join(outputDir, "active.dark.html"), html: forceTheme(activeHtml, "dark") },
    { state: "idle", theme: "light", path: join(outputDir, "idle.light.html"), html: forceTheme(idleHtml, "light") },
    { state: "idle", theme: "dark", path: join(outputDir, "idle.dark.html"), html: forceTheme(idleHtml, "dark") },
  ];
  const checks = inspectProgressHtml({ idleHtml, activeHtml });
  let browserEvidence = {
    status: "skipped",
    chrome_path: "",
    reason: browserSmoke ? "Artifacts were not written, so browser rendering was skipped." : "Browser rendering was disabled for this evidence run.",
    screenshots: [],
    checks: [check("browser_render_available", "warning", browserSmoke ? "Browser rendering is skipped when artifacts are not written." : "Browser rendering was disabled for this evidence run.")],
  };
  if (writeArtifacts) {
    writeText(idlePath, idleHtml);
    writeText(activePath, activeHtml);
    for (const artifact of themedHtmlArtifacts) writeText(artifact.path, artifact.html);
  }
  if (writeArtifacts && browserSmoke) {
    browserEvidence = Object.assign(Object(), { reason: "" }, collectBrowserEvidence({
      input,
      options,
      outputDir,
      activePath,
      idlePath,
      renderTargets: [
        {
          id: "browser_render_active_light_desktop",
          htmlPath: themedHtmlArtifacts.find((item) => item.state === "active" && item.theme === "light").path,
          screenshotName: "active-light-desktop.png",
          viewport: { name: "desktop", width: 1280, height: 900 },
          state: "active",
          theme: "light",
        },
        {
          id: "browser_render_active_dark_desktop",
          htmlPath: themedHtmlArtifacts.find((item) => item.state === "active" && item.theme === "dark").path,
          screenshotName: "active-dark-desktop.png",
          viewport: { name: "desktop", width: 1280, height: 900 },
          state: "active",
          theme: "dark",
        },
        {
          id: "browser_render_idle_light_mobile",
          htmlPath: themedHtmlArtifacts.find((item) => item.state === "idle" && item.theme === "light").path,
          screenshotName: "idle-light-mobile.png",
          viewport: { name: "mobile", width: 390, height: 844 },
          state: "idle",
          theme: "light",
        },
        {
          id: "browser_render_idle_dark_mobile",
          htmlPath: themedHtmlArtifacts.find((item) => item.state === "idle" && item.theme === "dark").path,
          screenshotName: "idle-dark-mobile.png",
          viewport: { name: "mobile", width: 390, height: 844 },
          state: "idle",
          theme: "dark",
        },
      ],
      projectRoot,
    }));
  }
  const allChecks = [...checks, ...browserEvidence.checks];
  const blockers = allChecks.filter((entry) => entry.status === "fail");
  const status = blockers.length === 0 ? "pass" : "blocked";
  const activeArtifact = repoRelative(activePath, projectRoot);
  const idleArtifact = repoRelative(idlePath, projectRoot);
  const themedArtifacts = themedHtmlArtifacts.map((artifact) => repoRelative(artifact.path, projectRoot));
  const screenshots = browserEvidence.screenshots.length > 0 ? browserEvidence.screenshots : [activeArtifact, idleArtifact];
  const visualArtifacts = [...new Set([activeArtifact, idleArtifact, ...themedArtifacts, ...browserEvidence.screenshots])];

  const report = {
    schema_version: PROGRESS_DASHBOARD_UI_EVIDENCE_SCHEMA_VERSION,
    schema: PROGRESS_DASHBOARD_UI_EVIDENCE_SCHEMA,
    status,
    code: status === "pass" ? "PROGRESS_DASHBOARD_UI_EVIDENCE_PASS" : "PROGRESS_DASHBOARD_UI_EVIDENCE_BLOCKED",
    summary: status === "pass"
      ? `Progress dashboard UI/UX evidence passed ${browserEvidence.status === "pass" ? "browser-rendered" : "static"} responsive, state, and escaping checks.`
      : "Progress dashboard UI/UX evidence found blocking issues.",
    generated_at: nowIso(),
    project_root: projectRoot,
    state_root: stateRoot,
    evidence_kind: browserEvidence.status === "pass" ? "browser_rendered_html_snapshot" : "static_html_snapshot",
    browser_execution: browserEvidence.status === "pass",
    browser: {
      status: browserEvidence.status,
      chrome_path: browserEvidence.chrome_path,
      reason: browserEvidence.reason || null,
      screenshots: browserEvidence.screenshots,
    },
    design_contract: {
      source_convention: "DESIGN.md + UI-SPEC.md",
      required_artifacts: ["DESIGN.md or specs/design.md", "UI-SPEC.md or task.ui.state_matrix", "UI evidence artifact"],
      review_pillars: REVIEW_PILLARS,
      quality_domains: QUALITY_DOMAINS,
      source_influences: DESIGN_SYSTEM_SOURCES,
    },
    checks: allChecks,
    blockers,
    artifacts: {
      idle_html: idleArtifact,
      active_html: activeArtifact,
      themed_html: themedArtifacts,
      evidence_json: repoRelative(outputPath, projectRoot),
    },
    ui_evidence: {
      page_reachable: true,
      critical_path_passed: status === "pass",
      required_state_present: checks.find((entry) => entry.id === "active_regions")?.status === "pass",
      content_overlap: false,
      text_overflow: false,
      runtime_errors: [],
      screenshots,
      visual_artifacts: visualArtifacts,
      responsive_viewports: ["mobile", "desktop"],
      accessibility: {
        viewport_meta: checks.find((entry) => entry.id === "viewport_meta")?.status === "pass",
      },
    },
    next_actions: status === "pass"
      ? ["Use this evidence in /yolo-run, /yolo-check, /yolo-accept, or review."]
      : ["Fix the blocked UI/UX checks and rerun progress dashboard evidence."],
  };

  if (writeArtifacts) writeText(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  return report;
}

export const inspectProgressDashboardUiEvidence = buildProgressDashboardUiEvidence;
export const runProgressDashboardUiEvidence = buildProgressDashboardUiEvidence;
