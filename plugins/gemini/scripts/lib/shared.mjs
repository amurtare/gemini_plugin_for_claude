/**
 * Re-exports from local copies of generic library modules.
 * These files are copied from the Codex plugin and contain no Codex-specific logic.
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
} from "./state.mjs";

// Job control
export {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./job-control.mjs";

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
} from "./tracked-jobs.mjs";

// Git utilities
export {
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget
} from "./git.mjs";

// Process utilities
export {
  binaryAvailable,
  terminateProcessTree
} from "./process.mjs";

// File system utilities
export {
  readJsonFile,
  readStdinIfPiped
} from "./fs.mjs";

// Argument parsing
export {
  parseArgs,
  splitRawArgumentString
} from "./args.mjs";

// Workspace resolution
export {
  resolveWorkspaceRoot
} from "./workspace.mjs";

// Prompt template utilities
export {
  loadPromptTemplate,
  interpolateTemplate
} from "./prompts.mjs";

// Render utilities
export {
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
  renderNativeReviewResult
} from "./render.mjs";
