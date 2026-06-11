import { join, resolve } from "node:path";

export function resolveRunnerContext(options = Object(), {
  packageRoot,
  config,
  yoloPath,
} = Object()) {
  const projectRoot = resolve(packageRoot, config.project.root);
  const stateRoot = packageRoot;
  const rootDir = resolve(options.projectRoot || options.project_root || projectRoot);
  const resolvedStateRoot = resolve(options.stateRoot || options.state_root || stateRoot);
  const stateDir = join(resolvedStateRoot, config.state.dir);
  const runtimeDir = yoloPath("runtime", resolvedStateRoot);
  return {
    rootDir,
    stateRoot: resolvedStateRoot,
    stateDir,
    runtimeDir,
    tscBaselinePath: join(runtimeDir, "tsc-baseline.json"),
    eslintBaselinePath: join(runtimeDir, "eslint-baseline.json"),
    resultsFile: yoloPath("taskResults", resolvedStateRoot),
    worktreeRoot: join(rootDir, "..", ".yolo-worktrees"),
    currentRunFile: yoloPath("currentRun", resolvedStateRoot),
    expandedTasksFile: join(stateDir, "expanded-tasks.json"),
    outputLog: join(stateDir, "yolo-output.log"),
  };
}

export function applyRunnerContextSideEffects(context, {
  ensureCanonicalDirs,
  setContractRoot,
  setTaskLogsDir,
} = Object()) {
  setContractRoot(context.rootDir);
  setTaskLogsDir(join(context.runtimeDir, "task-logs"));
  ensureCanonicalDirs(context.stateRoot);
}

export function createRunnerLifecycleState({
  getContext,
  getActiveGitSession,
  getProgressServerProc,
} = Object()) {
  return {
    stateDir: () => getContext().stateDir,
    currentRunFile: () => getContext().currentRunFile,
    rootDir: () => getContext().rootDir,
    activeGitSession: () => getActiveGitSession(),
    progressServerProc: () => getProgressServerProc(),
  };
}
