// YOLO CLI public entry point.
//
// This file was historically a single ~3300-line module. It has been split into
// focused modules under ./split/ by responsibility (argument parsing, PRD
// discovery, text formatting, release-candidate contract, interview helpers,
// lifecycle-guard wrappers, review-scope collection, and the subcommand
// runtimes). This file now re-exports the full public surface so existing
// imports from "../src/cli/yolo.js" continue to work unchanged, and retains
// only the top-level runYoloCli wrapper that surfaces CLI parse errors.
//
// This refactor is purely structural: no logic, public API, export signature,
// or runtime behavior has changed.

import { emitCliParseError, isCliParseError } from "./split/parse-helpers.js";

// Re-export the shared helpers and command registry entry point.
export { usage } from "./split/shared.js";
export { KNOWN_YOLO_COMMAND_WORDS } from "./split/shared.js";

// Re-export argument parsers.
export {
  parseYoloArgs,
  parseYoloAutoArgs,
  parseYoloInitArgs,
  parseYoloSetupArgs,
  parseYoloMemoryArgs,
  parseYoloReleaseCandidateArgs,
  parseYoloProgressUiEvidenceArgs,
  parseYoloCheckArgs,
  parseYoloAcceptArgs,
  parseYoloInterviewArgs,
  parseYoloWorkflowArgs,
} from "./split/parse-args.js";

// Re-export PRD discovery.
export { findLatestPrd, inferDefaultCliPrdPath } from "./split/prd-discovery.js";

// Re-export text formatters.
export {
  formatRunnerText,
  formatWorkflowPlanText,
  formatDiscoveryRuntimeText,
  formatDemandRuntimeText,
  formatDemandStatusText,
  formatDemandDispatchText,
  formatPiRuntimeText,
  formatYoloNextText,
  formatInitText,
  formatSetupText,
  formatInstallText,
  formatMemoryText,
} from "./split/text-format.js";

// Re-export release-candidate contract, builders, and normalizers.
export {
  RELEASE_CANDIDATE_RESULT_SCHEMA,
  RELEASE_CANDIDATE_REQUIRED_GATES,
  buildDefaultReleaseCandidateReports,
  runDefaultReleaseCandidateRunner,
  formatReleaseCandidateText,
} from "./split/release-candidate.js";

// Re-export subcommand runtimes.
export {
  runYoloInitCli,
  runYoloSetupCli,
  runYoloInstallCli,
  runYoloMemoryCli,
  runYoloReleaseCandidateCli,
  runYoloCheckCli,
  runYoloNextCli,
  runYoloProgressUiEvidenceCli,
  runYoloInterviewCli,
  runYoloBrainstormCli,
  runYoloDemandCli,
  runYoloDiscussCli,
  runYoloAcceptCli,
  runYoloDiscoverCli,
  runYoloPlanCli,
  runYoloPrdCli,
  runYoloWorkflowPlanCli,
  runYoloReviewCli,
  runYoloShipCli,
  runYoloLearnCli,
  runYoloReleaseCli,
  runYoloAutoCli,
} from "./split/commands.js";

// Top-level entry: wrap the inner dispatcher with CLI parse-error handling.
// Imported here (rather than re-exported) because runYoloCli owns the contract.
import { runYoloCliInner } from "./split/commands.js";

export async function runYoloCli(argv = process.argv.slice(2), io = Object()) {
  try {
    return await runYoloCliInner(argv, io);
  } catch (error) {
    if (isCliParseError(error)) return emitCliParseError(error, argv, io, "yolo");
    throw error;
  }
}
