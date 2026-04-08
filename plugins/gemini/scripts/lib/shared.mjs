/**
 * Re-exports from Codex plugin's generic library modules.
 * These modules are 100% reusable and contain no Codex-specific logic.
 */

// State persistence
export {
  resolveStateDir,
  resolveStateFile,
  resolveJobsDir,
  loadState,
  saveState,
  updateState,
  upsertJob,
  resolveJobFile,
  resolveJobLogFile,
  writeJobFile,
  readJobFile,
  setConfig,
  getConfig,
  generateJobId,
  listJobs
} from "../../../codex/scripts/lib/state.mjs";

// Job control
export {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "../../../codex/scripts/lib/job-control.mjs";

// Tracked jobs & progress
export {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "../../../codex/scripts/lib/tracked-jobs.mjs";

// Git utilities
export {
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget
} from "../../../codex/scripts/lib/git.mjs";

// Process utilities
export {
  binaryAvailable,
  terminateProcessTree
} from "../../../codex/scripts/lib/process.mjs";

// File system utilities
export {
  readJsonFile,
  readStdinIfPiped
} from "../../../codex/scripts/lib/fs.mjs";

// Argument parsing
export {
  parseArgs,
  splitRawArgumentString
} from "../../../codex/scripts/lib/args.mjs";

// Workspace resolution
export {
  resolveWorkspaceRoot
} from "../../../codex/scripts/lib/workspace.mjs";

// Prompt template utilities
export {
  loadPromptTemplate,
  interpolateTemplate
} from "../../../codex/scripts/lib/prompts.mjs";

// Render utilities (will be wrapped with Gemini branding in gemini-render.mjs)
export {
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
  renderNativeReviewResult
} from "../../../codex/scripts/lib/render.mjs";
