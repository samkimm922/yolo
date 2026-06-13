import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  listWorkflows,
  workflowToSkillDescriptor,
  WORKFLOW_SKILL_DESCRIPTOR_SCHEMA,
} from "./registry.js";
import { renderPMProtocolMarkdown } from "./pm-protocol.js";

export const WORKFLOW_SKILL_INSTALL_SCHEMA_VERSION = "1.0";
export const WORKFLOW_SKILL_INSTALL_PLAN_SCHEMA = "yolo.workflow.skill_install_plan.v1";
export const WORKFLOW_SKILL_TRIGGER_INDEX_SCHEMA = "yolo.workflow.skill_trigger_index.v1";
export const WORKFLOW_SKILL_TARGET_SMOKE_SCHEMA_VERSION = "1.0";
export const WORKFLOW_SKILL_TARGET_SMOKE_PLAN_SCHEMA = "yolo.workflow.skill_target_smoke_plan.v1";
export const WORKFLOW_SKILL_TARGET_SMOKE_RESULT_SCHEMA = "yolo.workflow.skill_target_smoke_result.v1";
export const WORKFLOW_SKILL_AGENT_RULES_FILE = "RULES.md";
export const WORKFLOW_SKILL_TRIGGER_INDEX_FILE = "triggers.json";

const DEFAULT_TARGET_DIRS = {
  yolo: ".yolo/skills",
  agents: ".agents/skills",
  claude: ".claude/skills",
  codex: ".codex/skills",
};

export const DEFAULT_WORKFLOW_SKILL_TARGET_SMOKE_TARGETS = ["yolo", "agents", "claude", "codex"];
export const DEFAULT_WORKFLOW_SKILL_TARGET_SMOKE_FORBIDDEN_PACKAGE_DIRS = [
  "state",
  "data",
  "logs",
  ".yolo",
  ".agents",
  ".claude",
  ".codex",
];

function cleanString(value) {
  return String(value ?? "").trim();
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function unique(values) {
  return [...new Set(values)];
}

function normalizedTargetList(value) {
  const targets = asArray(value).length > 0 ? asArray(value) : DEFAULT_WORKFLOW_SKILL_TARGET_SMOKE_TARGETS;
  return unique(targets.map((target) => cleanString(target).toLowerCase()).filter(Boolean));
}

function projectPath(projectRoot, path) {
  const absolute = isAbsolute(path) ? path : join(projectRoot, path);
  const rel = relative(projectRoot, absolute);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll("\\", "/") : absolute;
}

function resolveTargetDir(projectRoot, options = Object()) {
  if (options.targetDir) {
    const absolute = isAbsolute(options.targetDir) ? options.targetDir : join(projectRoot, options.targetDir);
    return {
      target: cleanString(options.target || "custom") || "custom",
      relative_dir: projectPath(projectRoot, absolute),
      absolute_dir: absolute,
    };
  }

  const target = cleanString(options.target || "yolo").toLowerCase();
  const relativeDir = DEFAULT_TARGET_DIRS[target];
  if (!relativeDir) {
    throw new Error(`Unknown workflow skill install target "${target}". Available targets: ${Object.keys(DEFAULT_TARGET_DIRS).join(", ")}`);
  }

  return {
    target,
    relative_dir: relativeDir,
    absolute_dir: join(projectRoot, relativeDir),
  };
}

function defaultAgentForTarget(target, agent) {
  const explicit = cleanString(agent);
  if (explicit) return explicit;
  if (target === "claude" || target === "codex") return target;
  return "generic";
}

function skillFolderName(id) {
  return cleanString(id).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

function yamlString(value) {
  return JSON.stringify(cleanString(value));
}

function skillMarkdownFilename(options = Object()) {
  return cleanString(options.skillMarkdownFile || options.skill_markdown_file || "SKILL.md") || "SKILL.md";
}

function expectedSkillPaths(targetDir, descriptors, markdownFile = "SKILL.md") {
  const paths = [
    `${targetDir}/${WORKFLOW_SKILL_AGENT_RULES_FILE}`,
    `${targetDir}/${WORKFLOW_SKILL_TRIGGER_INDEX_FILE}`,
    `${targetDir}/index.json`,
  ];
  for (const descriptor of descriptors) {
    const skillDir = `${targetDir}/${skillFolderName(descriptor.id)}`;
    paths.push(`${skillDir}/skill.json`, `${skillDir}/${markdownFile}`);
  }
  return paths;
}

function requiredString(errors, descriptor, field) {
  if (!cleanString(descriptor[field])) {
    errors.push({ code: "SKILL_FIELD_MISSING", field, message: `${field} is required` });
  }
}

function requiredArray(errors, descriptor, field) {
  if (!Array.isArray(descriptor[field]) || descriptor[field].length === 0) {
    errors.push({ code: "SKILL_ARRAY_EMPTY", field, message: `${field} must be a non-empty array` });
  }
}

export function validateWorkflowSkillDescriptor(descriptor = Object()) {
  const errors = [];
  const warnings = [];

  requiredString(errors, descriptor, "id");
  requiredString(errors, descriptor, "name");
  requiredString(errors, descriptor, "agent");
  requiredString(errors, descriptor, "workflow");
  requiredString(errors, descriptor, "purpose");
  requiredArray(errors, descriptor, "trigger");
  requiredArray(errors, descriptor, "inputs");
  requiredArray(errors, descriptor, "outputs");
  requiredArray(errors, descriptor, "sdk_namespaces");
  requiredArray(errors, descriptor, "phases");
  requiredArray(errors, descriptor, "verification");

  if (descriptor.schema !== WORKFLOW_SKILL_DESCRIPTOR_SCHEMA) {
    errors.push({
      code: "SKILL_SCHEMA_MISMATCH",
      field: "schema",
      expected: WORKFLOW_SKILL_DESCRIPTOR_SCHEMA,
      actual: descriptor.schema,
      message: "skill descriptor schema is not supported",
    });
  }

  const entrypoints = descriptor.entrypoints || {};
  for (const field of ["sdk", "cli", "skill"]) {
    if (!cleanString(entrypoints[field])) {
      errors.push({ code: "SKILL_ENTRYPOINT_MISSING", field: `entrypoints.${field}`, message: `entrypoints.${field} is required` });
    }
  }

  if (cleanString(entrypoints.skill) && cleanString(descriptor.id) && entrypoints.skill !== descriptor.id) {
    errors.push({
      code: "SKILL_ID_ENTRYPOINT_MISMATCH",
      field: "entrypoints.skill",
      message: "descriptor id must match the skill entrypoint",
    });
  }

  if (Array.isArray(descriptor.verification) && descriptor.verification.some((item) => cleanString(item) === "")) {
    warnings.push({
      code: "SKILL_EMPTY_VERIFICATION_ITEM",
      field: "verification",
      message: "empty verification hooks should be removed",
    });
  }

  return {
    status: errors.length > 0 ? "invalid" : (warnings.length > 0 ? "warning" : "pass"),
    valid: errors.length === 0,
    descriptor_id: descriptor.id || null,
    errors,
    warnings,
  };
}

function renderSkillMarkdown(descriptor) {
  // Demand / interview workflows use the full PM protocol prompt
  if (descriptor.workflow === "demand" || descriptor.workflow === "interview") {
    return renderPMProtocolMarkdown(descriptor);
  }

  const lines = [
    "---",
    `name: ${yamlString(descriptor.id)}`,
    `description: ${yamlString(descriptor.purpose)}`,
    "---",
    "",
    `# ${descriptor.name}`,
    "",
    `Schema: ${descriptor.schema}`,
    `Workflow: ${descriptor.workflow}`,
    `Agent: ${descriptor.agent}`,
    `Surface: ${descriptor.surface || "internal"}`,
    `Stability: ${descriptor.stability || "internal"}`,
    `Visibility: ${descriptor.visibility || "hidden"}`,
    descriptor.alias_for ? `Alias for: ${descriptor.alias_for}` : null,
    "",
    "## Purpose",
    "",
    descriptor.purpose,
    "",
    "## Triggers",
    "",
    ...descriptor.trigger.map((item) => `- ${item}`),
    "",
    "## Inputs",
    "",
    ...descriptor.inputs.map((item) => `- ${item}`),
    "",
    "## Outputs",
    "",
    ...descriptor.outputs.map((item) => `- ${item}`),
    "",
    "## Phases",
    "",
    ...descriptor.phases.map((item) => `- ${item}`),
    "",
    "## Verification",
    "",
    ...descriptor.verification.map((item) => `- ${item}`),
    "",
    "## Entrypoints",
    "",
    `- SDK: ${descriptor.entrypoints.sdk}`,
    `- CLI: ${descriptor.entrypoints.cli}`,
    `- Skill: ${descriptor.entrypoints.skill}`,
    "",
    "## Execution Contract",
    "",
    "- Keep requirements, design, tasks, and evidence traceable.",
    "- This descriptor is not permission to advance to downstream workflows automatically.",
    "- Complete only the listed workflow outputs and stop; a later workflow needs an explicit matching trigger or user-selected `/yolo-*` stage command.",
    "- If this workflow lists `no_code_change`, do not compile executable PRD, run implementation, fix code, or edit source files from this workflow.",
    "- Fail closed when a required verification hook cannot run.",
    "- Do not assume one model; inspect provider capability before execution.",
    "",
  ].filter((line) => line !== null);
  return lines.join("\n");
}

function buildWorkflowSkillTriggerIndex(targetInfo, descriptors, markdownFile = "SKILL.md") {
  const triggers = [];
  for (const descriptor of descriptors) {
    for (const trigger of descriptor.trigger || []) {
      triggers.push({
        trigger,
        skill_id: descriptor.id,
        workflow: descriptor.workflow,
        agent: descriptor.agent,
        descriptor_path: `${targetInfo.relative_dir}/${skillFolderName(descriptor.id)}/skill.json`,
        markdown_path: `${targetInfo.relative_dir}/${skillFolderName(descriptor.id)}/${markdownFile}`,
        entrypoints: {
          sdk: descriptor.entrypoints?.sdk || null,
          cli: descriptor.entrypoints?.cli || null,
          skill: descriptor.entrypoints?.skill || descriptor.id,
        },
        surface: descriptor.surface || "internal",
        stability: descriptor.stability || "internal",
        visibility: descriptor.visibility || "hidden",
        alias_for: descriptor.alias_for || null,
      });
    }
  }

  triggers.sort((left, right) =>
    `${left.trigger}:${left.skill_id}`.localeCompare(`${right.trigger}:${right.skill_id}`)
  );

  return {
    schema_version: WORKFLOW_SKILL_INSTALL_SCHEMA_VERSION,
    schema: WORKFLOW_SKILL_TRIGGER_INDEX_SCHEMA,
    target: targetInfo.target,
    target_dir: targetInfo.relative_dir,
    convention: "route a matching trigger to the named skill descriptor, complete only that workflow, then stop unless a later workflow is explicitly selected; fail closed when required inputs, PRD/spec gates, or verification hooks are missing",
    triggers,
  };
}

function renderTargetRulesMarkdown(targetInfo, descriptors, triggerIndex, markdownFile = "SKILL.md") {
  const triggerLines = triggerIndex.triggers.length > 0
    ? triggerIndex.triggers.map((item) =>
      `- ${item.trigger} -> ${item.skill_id} (${item.entrypoints.cli})`
    )
    : ["- No triggers installed."];

  const lines = [
    "# YOLO Workflow Agent Rules",
    "",
    `Schema: yolo.workflow.agent_rules.v1`,
    `Target: ${targetInfo.target}`,
    `Target dir: ${targetInfo.relative_dir}`,
    "",
    "## Source Of Truth",
    "",
    "- Treat `skill.json` as the machine-readable workflow contract.",
    `- Treat \`${markdownFile}\` as the human-readable workflow guide.`,
    "- Treat `triggers.json` as the trigger routing index for this target.",
    "- Keep runtime artifacts under the consumer project state root, not under the YOLO package root.",
    "",
    "## Activation",
    "",
    "- Start a workflow only when the current user intent, CLI event, or automation event matches a listed trigger.",
    "- Route the trigger to exactly one listed skill unless a caller explicitly selects multiple workflows.",
    "- Default user-facing commands are limited to: status, demand, spec, tasks, run, check, review, release.",
    "- Hidden compatibility and internal workflow descriptors may exist, but they must keep alias_for, stability, and visibility metadata.",
    `- Re-read the selected \`skill.json\` before execution and use \`${markdownFile}\` only for agent-readable guidance.`,
    "",
    "## Gate Policy",
    "",
    "- A selected workflow is terminal for the current turn unless the caller explicitly selected a later workflow.",
    "- Do not treat user approval of a no-code workflow as permission to implement code.",
    "- Fail closed when required PRD, spec, evidence, review, lint, test, or release gates cannot run.",
    "- Do not mark a workflow complete until every listed verification hook has either passed or produced a blocking finding.",
    "- Preserve traceability from requirement to task, implementation, review finding, fix, and final evidence.",
    "",
    "## Triggers",
    "",
    ...triggerLines,
    "",
    "## Installed Skills",
    "",
    ...descriptors.map((descriptor) => `- ${descriptor.id}: ${descriptor.name}`),
    "",
  ];
  return lines.join("\n");
}

function descriptorsForInstall(options = Object()) {
  const workflowIds = asArray(options.workflow || options.workflows);
  const selectedIds = workflowIds.length > 0 ? workflowIds : listWorkflows().map((workflow) => workflow.id);
  const agent = defaultAgentForTarget(options.target, options.agent);
  return selectedIds.map((id) => workflowToSkillDescriptor(id, { agent }));
}

export function buildWorkflowSkillInstallPlan(options = Object()) {
  const projectRoot = resolve(options.projectRoot || options.cwd || process.cwd());
  const targetInfo = resolveTargetDir(projectRoot, options);
  const descriptors = descriptorsForInstall({
    ...options,
    target: targetInfo.target,
  });
  const markdownFile = skillMarkdownFilename(options);

  const directories = [targetInfo.relative_dir];
  const files = [];
  const triggerIndex = buildWorkflowSkillTriggerIndex(targetInfo, descriptors, markdownFile);

  for (const descriptor of descriptors) {
    const skillDir = join(targetInfo.relative_dir, skillFolderName(descriptor.id));
    directories.push(skillDir);
    files.push({
      path: `${skillDir}/skill.json`,
      role: "skill_descriptor",
      descriptor_id: descriptor.id,
      content: stableJson(descriptor),
    });
    files.push({
      path: `${skillDir}/${markdownFile}`,
      role: "skill_markdown",
      descriptor_id: descriptor.id,
      content: renderSkillMarkdown(descriptor),
    });
  }

  files.push({
    path: `${targetInfo.relative_dir}/${WORKFLOW_SKILL_AGENT_RULES_FILE}`,
    role: "agent_rules",
    descriptor_id: null,
    content: renderTargetRulesMarkdown(targetInfo, descriptors, triggerIndex, markdownFile),
  });
  files.push({
    path: `${targetInfo.relative_dir}/${WORKFLOW_SKILL_TRIGGER_INDEX_FILE}`,
    role: "trigger_index",
    descriptor_id: null,
    content: stableJson(triggerIndex),
  });
  files.push({
    path: `${targetInfo.relative_dir}/index.json`,
    role: "skill_index",
    descriptor_id: null,
    content: stableJson({
      schema_version: WORKFLOW_SKILL_INSTALL_SCHEMA_VERSION,
      schema: "yolo.workflow.skill_index.v1",
      target: targetInfo.target,
      skills: descriptors.map((descriptor) => ({
        id: descriptor.id,
        workflow: descriptor.workflow,
        agent: descriptor.agent,
        surface: descriptor.surface || "internal",
        stability: descriptor.stability || "internal",
        visibility: descriptor.visibility || "hidden",
        alias_for: descriptor.alias_for || null,
        path: `${targetInfo.relative_dir}/${skillFolderName(descriptor.id)}/skill.json`,
      })),
    }),
  });

  const validation = inspectWorkflowSkillInstallPlan({
    schema_version: WORKFLOW_SKILL_INSTALL_SCHEMA_VERSION,
    schema: WORKFLOW_SKILL_INSTALL_PLAN_SCHEMA,
    project_root: projectRoot,
    target: targetInfo.target,
    target_dir: targetInfo.relative_dir,
    skill_markdown_file: markdownFile,
    directories: unique(directories),
    descriptors,
    files,
  });

  return {
    schema_version: WORKFLOW_SKILL_INSTALL_SCHEMA_VERSION,
    schema: WORKFLOW_SKILL_INSTALL_PLAN_SCHEMA,
    project_root: projectRoot,
    target: targetInfo.target,
    target_dir: targetInfo.relative_dir,
    skill_markdown_file: markdownFile,
    directories: unique(directories),
    descriptors,
    files,
    file_count: files.length,
    validation,
  };
}

export function inspectWorkflowSkillInstallPlan(plan = Object()) {
  const descriptorResults = (plan.descriptors || []).map(validateWorkflowSkillDescriptor);
  const errors = descriptorResults.flatMap((result) => result.errors.map((error) => ({
    descriptor_id: result.descriptor_id,
    ...error,
  })));
  const warnings = descriptorResults.flatMap((result) => result.warnings.map((warning) => ({
    descriptor_id: result.descriptor_id,
    ...warning,
  })));

  if (!Array.isArray(plan.files) || plan.files.length === 0) {
    errors.push({ code: "SKILL_INSTALL_FILES_EMPTY", message: "install plan must include files" });
  }

  const paths = (plan.files || []).map((file) => file.path);
  for (const path of paths) {
    if (!cleanString(path)) {
      errors.push({ code: "SKILL_INSTALL_PATH_EMPTY", message: "install file path is required" });
    }
  }
  const duplicate = paths.find((path, index) => paths.indexOf(path) !== index);
  if (duplicate) {
    errors.push({ code: "SKILL_INSTALL_DUPLICATE_PATH", path: duplicate, message: "install plan contains duplicate file paths" });
  }

  const roles = new Set((plan.files || []).map((file) => file.role));
  if (!roles.has("agent_rules")) {
    errors.push({ code: "SKILL_INSTALL_AGENT_RULES_MISSING", message: "install plan must include target agent rules" });
  }
  if (!roles.has("trigger_index")) {
    errors.push({ code: "SKILL_INSTALL_TRIGGER_INDEX_MISSING", message: "install plan must include target trigger index" });
  }

  const rulesFile = (plan.files || []).find((file) => file.role === "agent_rules");
  if (rulesFile && !String(rulesFile.content || "").includes("Fail closed")) {
    errors.push({ code: "SKILL_INSTALL_AGENT_RULES_INCOMPLETE", message: "agent rules must include fail-closed gate policy" });
  }

  const triggerFile = (plan.files || []).find((file) => file.role === "trigger_index");
  if (triggerFile) {
    try {
      const triggerIndex = JSON.parse(triggerFile.content);
      if (triggerIndex.schema !== WORKFLOW_SKILL_TRIGGER_INDEX_SCHEMA) {
        errors.push({
          code: "SKILL_INSTALL_TRIGGER_INDEX_SCHEMA",
          expected: WORKFLOW_SKILL_TRIGGER_INDEX_SCHEMA,
          actual: triggerIndex.schema,
          message: "trigger index schema is not supported",
        });
      }
      if (triggerIndex.target !== plan.target) {
        errors.push({
          code: "SKILL_INSTALL_TRIGGER_INDEX_TARGET",
          expected: plan.target,
          actual: triggerIndex.target,
          message: "trigger index target must match install target",
        });
      }

      const triggerRows = Array.isArray(triggerIndex.triggers) ? triggerIndex.triggers : [];
      for (const descriptor of plan.descriptors || []) {
        for (const trigger of descriptor.trigger || []) {
          const listed = triggerRows.some((item) => item.trigger === trigger && item.skill_id === descriptor.id);
          if (!listed) {
            errors.push({
              code: "SKILL_INSTALL_TRIGGER_INDEX_MISSING_TRIGGER",
              descriptor_id: descriptor.id,
              trigger,
              message: "trigger index must include every descriptor trigger",
            });
          }
        }
      }
    } catch (error) {
      errors.push({
        code: "SKILL_INSTALL_TRIGGER_INDEX_PARSE",
        message: "trigger index must be valid JSON",
        error: error?.message || String(error),
      });
    }
  }

  return {
    status: errors.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass"),
    ready: errors.length === 0,
    descriptor_results: descriptorResults,
    errors,
    warnings,
  };
}

export function installWorkflowSkills(options = Object()) {
  const plan = buildWorkflowSkillInstallPlan(options);
  if (!plan.validation.ready) {
    return {
      status: "blocked",
      summary: "workflow skill install plan failed validation",
      exit_code: 1,
      dry_run: options.dryRun === true || options.dry_run === true,
      force: options.force === true,
      plan,
      validation: plan.validation,
      created_dirs: [],
      created: [],
      overwritten: [],
      skipped: [],
    };
  }

  const dryRun = options.dryRun === true || options.dry_run === true;
  const force = options.force === true;
  const createdDirs = [];
  const created = [];
  const overwritten = [];
  const skipped = [];

  for (const dirValue of plan.directories) {
    const dir = String(dirValue);
    const absoluteDir = isAbsolute(dir) ? dir : join(plan.project_root, dir);
    if (!existsSync(absoluteDir)) {
      createdDirs.push(dir);
      if (!dryRun) mkdirSync(absoluteDir, { recursive: true });
    }
  }

  for (const file of plan.files) {
    const absoluteFile = isAbsolute(file.path) ? file.path : join(plan.project_root, file.path);
    const exists = existsSync(absoluteFile);
    if (exists && !force) {
      skipped.push(file.path);
      continue;
    }

    if (!dryRun) {
      mkdirSync(dirname(absoluteFile), { recursive: true });
      writeFileSync(absoluteFile, file.content, "utf8");
    }

    if (exists) overwritten.push(file.path);
    else created.push(file.path);
  }

  return {
    status: "success",
    summary: dryRun ? "planned YOLO workflow skill install" : "installed YOLO workflow skills",
    exit_code: 0,
    schema_version: plan.schema_version,
    schema: plan.schema,
    project_root: plan.project_root,
    target: plan.target,
    target_dir: plan.target_dir,
    dry_run: dryRun,
    force,
    descriptors: plan.descriptors,
    created_dirs: createdDirs,
    created,
    overwritten,
    skipped,
    validation: plan.validation,
    artifacts: plan.files.map((file) => file.path),
  };
}

export function buildWorkflowSkillTargetSmokePlan(options = Object()) {
  // 烟测默认写入一次性 tmpdir 沙盒，绝不落到真实 cwd/.agents——避免污染当前项目。
  // 仅当显式传入 projectRoot/cwd 时才使用指定目录（测试用临时沙盒）。
  const explicitRoot = options.projectRoot || options.cwd;
  const projectRoot = explicitRoot
    ? resolve(explicitRoot)
    : mkdtempSync(join(tmpdir(), "yolo-workflow-smoke-"));
  const packageRoot = options.packageRoot || options.package_root
    ? resolve(options.packageRoot || options.package_root)
    : null;
  const targets = normalizedTargetList(options.targets || options.target);
  const workflows = asArray(options.workflow || options.workflows).length > 0
    ? asArray(options.workflow || options.workflows).map(cleanString).filter(Boolean)
    : ["fix"];
  const agentByTarget = options.agentByTarget || options.agent_by_target || {};

  const targetPlans = targets.map((targetValue) => {
    const target = String(targetValue);
    const agent = cleanString(agentByTarget[target] || options.agent);
    const installPlan = buildWorkflowSkillInstallPlan({
      projectRoot,
      target,
      workflows,
      agent,
    });
    return {
      target: installPlan.target,
      target_dir: installPlan.target_dir,
      agent: installPlan.descriptors[0]?.agent || defaultAgentForTarget(installPlan.target, agent),
      workflows,
      expected_files: expectedSkillPaths(installPlan.target_dir, installPlan.descriptors),
      descriptor_ids: installPlan.descriptors.map((descriptor) => descriptor.id),
    };
  });

  return {
    schema_version: WORKFLOW_SKILL_TARGET_SMOKE_SCHEMA_VERSION,
    schema: WORKFLOW_SKILL_TARGET_SMOKE_PLAN_SCHEMA,
    project_root: projectRoot,
    package_root: packageRoot,
    targets: targetPlans,
    forbidden_package_dirs: options.forbiddenPackageDirs
      || options.forbidden_package_dirs
      || DEFAULT_WORKFLOW_SKILL_TARGET_SMOKE_FORBIDDEN_PACKAGE_DIRS,
  };
}

function check(passed, code, message, extra = Object()) {
  return {
    code,
    passed: Boolean(passed),
    message,
    ...extra,
  };
}

export function runWorkflowSkillTargetSmoke(options = Object()) {
  const plan = buildWorkflowSkillTargetSmokePlan(options);
  const dryRun = options.dryRun === true || options.dry_run === true;
  if (dryRun) {
    return {
      status: "success",
      summary: "planned workflow skill target smoke",
      exit_code: 0,
      dry_run: true,
      schema_version: WORKFLOW_SKILL_TARGET_SMOKE_SCHEMA_VERSION,
      schema: WORKFLOW_SKILL_TARGET_SMOKE_RESULT_SCHEMA,
      plan,
      installs: [],
      checks: [],
      package_root_checks: [],
    };
  }

  const installs = [];
  const checks = [];
  const force = options.force === true;

  for (const targetPlan of plan.targets) {
    const install = installWorkflowSkills({
      projectRoot: plan.project_root,
      target: targetPlan.target,
      workflows: targetPlan.workflows,
      agent: targetPlan.agent,
      force,
    });
    installs.push(install);
    checks.push(check(
      install.status === "success",
      "WORKFLOW_SKILL_TARGET_INSTALL_SUCCESS",
      "workflow skill target install must succeed",
      { target: targetPlan.target, target_dir: targetPlan.target_dir },
    ));
    checks.push(check(
      install.target_dir === targetPlan.target_dir,
      "WORKFLOW_SKILL_TARGET_DIR_MATCH",
      "installed target directory must match the target convention",
      { target: targetPlan.target, expected: targetPlan.target_dir, actual: install.target_dir },
    ));

    for (const expectedFile of targetPlan.expected_files) {
      checks.push(check(
        existsSync(join(plan.project_root, expectedFile)),
        "WORKFLOW_SKILL_TARGET_FILE_EXISTS",
        "expected skill target artifact must exist",
        { target: targetPlan.target, file: expectedFile },
      ));
    }

    const indexPath = join(plan.project_root, targetPlan.target_dir, "index.json");
    if (existsSync(indexPath)) {
      try {
        const index = readJsonFile(indexPath);
        checks.push(check(
          index.target === targetPlan.target,
          "WORKFLOW_SKILL_TARGET_INDEX_TARGET",
          "skill index target must match the install target",
          { target: targetPlan.target, actual: index.target },
        ));
        checks.push(check(
          targetPlan.descriptor_ids.every((id) => index.skills?.some((skill) => skill.id === id)),
          "WORKFLOW_SKILL_TARGET_INDEX_SKILLS",
          "skill index must list every installed descriptor",
          { target: targetPlan.target, descriptor_ids: targetPlan.descriptor_ids },
        ));
      } catch (error) {
        checks.push(check(false, "WORKFLOW_SKILL_TARGET_INDEX_PARSE", "skill index must be valid JSON", {
          target: targetPlan.target,
          error: error?.message || String(error),
        }));
      }
    }

    const triggerIndexPath = join(plan.project_root, targetPlan.target_dir, WORKFLOW_SKILL_TRIGGER_INDEX_FILE);
    if (existsSync(triggerIndexPath)) {
      try {
        const triggerIndex = readJsonFile(triggerIndexPath);
        const triggerRows = Array.isArray(triggerIndex.triggers) ? triggerIndex.triggers : [];
        checks.push(check(
          triggerIndex.schema === WORKFLOW_SKILL_TRIGGER_INDEX_SCHEMA,
          "WORKFLOW_SKILL_TARGET_TRIGGER_INDEX_SCHEMA",
          "trigger index schema must match the workflow convention",
          { target: targetPlan.target, expected: WORKFLOW_SKILL_TRIGGER_INDEX_SCHEMA, actual: triggerIndex.schema },
        ));
        checks.push(check(
          triggerIndex.target === targetPlan.target,
          "WORKFLOW_SKILL_TARGET_TRIGGER_INDEX_TARGET",
          "trigger index target must match the install target",
          { target: targetPlan.target, expected: targetPlan.target, actual: triggerIndex.target },
        ));
        checks.push(check(
          targetPlan.descriptor_ids.every((id) => triggerRows.some((item) => item.skill_id === id)),
          "WORKFLOW_SKILL_TARGET_TRIGGER_INDEX_SKILLS",
          "trigger index must route every installed descriptor",
          { target: targetPlan.target, descriptor_ids: targetPlan.descriptor_ids },
        ));
      } catch (error) {
        checks.push(check(false, "WORKFLOW_SKILL_TARGET_TRIGGER_INDEX_PARSE", "trigger index must be valid JSON", {
          target: targetPlan.target,
          error: error?.message || String(error),
        }));
      }
    }

    const rulesPath = join(plan.project_root, targetPlan.target_dir, WORKFLOW_SKILL_AGENT_RULES_FILE);
    if (existsSync(rulesPath)) {
      const rules = readFileSync(rulesPath, "utf8");
      checks.push(check(
        rules.includes("skill.json") && rules.includes("triggers.json") && rules.includes("Fail closed"),
        "WORKFLOW_SKILL_TARGET_RULES_MARKDOWN",
        "agent rules must describe skill descriptor, trigger index, and fail-closed policy",
        { target: targetPlan.target, file: `${targetPlan.target_dir}/${WORKFLOW_SKILL_AGENT_RULES_FILE}` },
      ));
    }

    for (const descriptorId of targetPlan.descriptor_ids) {
      const descriptorPath = join(plan.project_root, targetPlan.target_dir, skillFolderName(descriptorId), "skill.json");
      if (!existsSync(descriptorPath)) continue;
      try {
        const descriptor = readJsonFile(descriptorPath);
        const validation = validateWorkflowSkillDescriptor(descriptor);
        checks.push(check(
          validation.valid,
          "WORKFLOW_SKILL_TARGET_DESCRIPTOR_VALID",
          "installed skill descriptor must validate",
          { target: targetPlan.target, descriptor_id: descriptorId, validation_status: validation.status },
        ));
        checks.push(check(
          descriptor.agent === targetPlan.agent,
          "WORKFLOW_SKILL_TARGET_AGENT_MATCH",
          "installed skill descriptor agent must match the target convention",
          { target: targetPlan.target, descriptor_id: descriptorId, expected: targetPlan.agent, actual: descriptor.agent },
        ));
      } catch (error) {
        checks.push(check(false, "WORKFLOW_SKILL_TARGET_DESCRIPTOR_PARSE", "installed skill descriptor must be valid JSON", {
          target: targetPlan.target,
          descriptor_id: descriptorId,
          error: error?.message || String(error),
        }));
      }
    }
  }

  const packageRootChecks = [];
  if (plan.package_root && resolve(plan.package_root) !== resolve(plan.project_root)) {
    for (const dir of plan.forbidden_package_dirs) {
      const absoluteDir = join(plan.package_root, dir);
      packageRootChecks.push(check(
        !existsSync(absoluteDir),
        "WORKFLOW_SKILL_PACKAGE_ROOT_CLEAN",
        "workflow skill target smoke must not create writable state or skill target dirs under the package root",
        { dir, path: absoluteDir },
      ));
    }
  }

  const failedChecks = [...checks, ...packageRootChecks].filter((item) => !item.passed);
  return {
    status: failedChecks.length === 0 ? "pass" : "blocked",
    summary: failedChecks.length === 0
      ? "workflow skill target smoke passed"
      : "workflow skill target smoke blocked",
    exit_code: failedChecks.length === 0 ? 0 : 1,
    dry_run: false,
    schema_version: WORKFLOW_SKILL_TARGET_SMOKE_SCHEMA_VERSION,
    schema: WORKFLOW_SKILL_TARGET_SMOKE_RESULT_SCHEMA,
    plan,
    installs,
    checks,
    package_root_checks: packageRootChecks,
    failed_checks: failedChecks,
  };
}
