/**
 * High-level Gemini API — equivalent of codex.mjs.
 *
 * Provides runGeminiTurn, runGeminiReview, getGeminiAvailability,
 * getGeminiAuthStatus, interruptGeminiTurn, findLatestTaskThread.
 */

import { readJsonFile, binaryAvailable } from "./shared.mjs";
import { BROKER_ENDPOINT_ENV, BROKER_BUSY_RPC_CODE, GeminiAppServerClient } from "./gemini-app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";

const SERVICE_NAME = "claude_code_gemini_plugin";
const TASK_THREAD_PREFIX = "Gemini Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

export { DEFAULT_CONTINUE_PROMPT };

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function cleanGeminiStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING:"))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Availability & Auth
// ---------------------------------------------------------------------------

export function getGeminiAvailability(cwd) {
  const geminiStatus = binaryAvailable("gemini", ["--version"], { cwd });
  return {
    available: geminiStatus.available,
    version: geminiStatus.version ?? null,
    detail: geminiStatus.available ? "Gemini CLI is installed." : "Gemini CLI not found."
  };
}

export async function getGeminiAuthStatus(cwd) {
  // Check GEMINI_API_KEY env var
  if (process.env.GEMINI_API_KEY) {
    return {
      available: true,
      loggedIn: true,
      detail: "Authenticated via GEMINI_API_KEY environment variable.",
      source: "env",
      authMethod: "api-key",
      verified: null,
      requiresGoogleAuth: false,
      provider: "google"
    };
  }

  // Check GOOGLE_API_KEY (Vertex AI)
  if (process.env.GOOGLE_API_KEY) {
    return {
      available: true,
      loggedIn: true,
      detail: "Authenticated via GOOGLE_API_KEY environment variable.",
      source: "env",
      authMethod: "api-key",
      verified: null,
      requiresGoogleAuth: false,
      provider: "google-vertex"
    };
  }

  // Check Google OAuth — try running gemini with a quick check
  // For now, assume not logged in if no API key
  return {
    available: true,
    loggedIn: false,
    detail: "No GEMINI_API_KEY or GOOGLE_API_KEY found. Run `gemini` to authenticate via Google OAuth, or set GEMINI_API_KEY.",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresGoogleAuth: true,
    provider: null
  };
}

export function getSessionRuntimeStatus() {
  const brokerEndpoint = process.env[BROKER_ENDPOINT_ENV] ?? null;
  return {
    brokerEndpoint,
    brokerActive: Boolean(brokerEndpoint)
  };
}

// ---------------------------------------------------------------------------
// Thread params
// ---------------------------------------------------------------------------

function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  };
}

function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

// ---------------------------------------------------------------------------
// Turn capture — notification handling
// ---------------------------------------------------------------------------

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) return message.params.turnId;
  if (message?.params?.turn?.id) return message.params.turn.id;
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fc of fileChanges) {
    for (const change of fc.changes ?? []) {
      if (change.path) paths.add(change.path);
    }
  }
  return [...paths];
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) return;
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) return;
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null) {
  if (state.completed) return;
  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) state.turnId = turn.id;
  } else if (!state.finalTurn) {
    state.finalTurn = { id: state.turnId ?? "inferred-turn", status: "completed" };
  }
  state.resolveCompletion(state);
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "turn/started":
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        { threadId: message.params.threadId, turnId: message.params.turn.id }
      );
      break;
    case "item/started": {
      const item = message.params.item;
      if (item.type === "commandExecution") {
        emitProgress(state.onProgress, `Running command: ${shorten(item.command, 96)}`,
          looksLikeVerificationCommand(item.command) ? "verifying" : "running");
      } else if (item.type === "fileChange") {
        emitProgress(state.onProgress, `Applying file change(s).`, "editing");
      } else if (item.type === "agentMessage") {
        // streaming message — accumulate
      }
      break;
    }
    case "item/completed": {
      const item = message.params.item;
      if (item.type === "agentMessage") {
        state.lastAgentMessage = item.text ?? "";
        state.messages.push({ lifecycle: "completed", phase: item.phase ?? null, text: item.text ?? "" });
        if (item.phase === "final_answer") {
          state.finalAnswerSeen = true;
        }
        emitLogEvent(state.onProgress, {
          message: `Assistant message captured: ${shorten(item.text, 96)}`,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: "Assistant message",
          logBody: item.text
        });
      } else if (item.type === "fileChange") {
        state.fileChanges.push(item);
        emitProgress(state.onProgress, `File changes completed.`, "editing");
      } else if (item.type === "commandExecution") {
        state.commandExecutions.push(item);
        emitProgress(state.onProgress, `Command ${item.status}: ${shorten(item.command, 96)} (exit ${item.exitCode ?? "?"})`,
          looksLikeVerificationCommand(item.command) ? "verifying" : "running");
      }
      break;
    }
    case "error":
      state.error = message.params.error ?? message.params;
      emitProgress(state.onProgress, `Gemini error: ${message.params?.error?.message ?? message.params?.message ?? "unknown"}`, "failed");
      break;
    case "turn/completed":
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn?.status === "completed" ? "completed" : message.params.turn?.status ?? "finished"}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) return false;
  return true;
}

async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((message) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }
    if (!belongsToTurn(state, message)) {
      if (previousHandler) previousHandler(message);
      return;
    }
    applyTurnNotification(state, message);
  });

  try {
    const response = await startRequest();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    for (const msg of state.bufferedNotifications) {
      if (belongsToTurn(state, msg)) {
        applyTurnNotification(state, msg);
      } else if (previousHandler) {
        previousHandler(msg);
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await state.completion;
  } finally {
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

// ---------------------------------------------------------------------------
// App Server connection
// ---------------------------------------------------------------------------

async function withAppServer(cwd, fn) {
  let client = null;
  try {
    client = await GeminiAppServerClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) throw error;

    const directClient = await GeminiAppServerClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch {
      // Suppress errors — name setting is optional
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Public API — runGeminiTurn
// ---------------------------------------------------------------------------

export async function runAppServerTurn(cwd, options = {}) {
  return withAppServer(cwd, async (client) => {
    let threadId;
    if (options.resumeThreadId) {
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox ?? "read-only"
      });
      threadId = response.thread.id;
    } else {
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox ?? "read-only",
        ephemeral: !options.persistThread,
        threadName: options.threadName
      });
      threadId = response.thread.id;
    }

    const prompt = options.prompt || options.defaultPrompt || "";
    const turnState = await captureTurn(
      client,
      threadId,
      () =>
        client.request("turn/start", {
          threadId,
          input: buildTurnInput(prompt),
          model: options.model ?? null,
          effort: options.effort ?? null,
          outputSchema: options.outputSchema ?? null
        }),
      { onProgress: options.onProgress }
    );

    const status = buildResultStatus(turnState);
    const finalMessage = turnState.lastAgentMessage || "";
    const stderr = cleanGeminiStderr(client.stderr || "");

    return {
      status,
      threadId,
      turnId: turnState.turnId,
      finalMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr,
      reviewText: turnState.reviewText,
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions
    };
  });
}

// ---------------------------------------------------------------------------
// Public API — runGeminiReview
// ---------------------------------------------------------------------------

export async function runAppServerReview(cwd, options = {}) {
  return withAppServer(cwd, async (client) => {
    const turnState = await captureTurn(
      client,
      null,
      () =>
        client.request("review/start", {
          cwd,
          reviewTarget: options.target,
          model: options.model ?? null
        }),
      {
        onProgress: options.onProgress,
        onResponse(response, state) {
          state.threadId = response.reviewThreadId;
          state.rootThreadId = response.reviewThreadId;
          state.threadIds.add(response.reviewThreadId);
        }
      }
    );

    const status = buildResultStatus(turnState);
    return {
      status,
      threadId: turnState.threadId,
      sourceThreadId: null,
      turnId: turnState.turnId,
      reviewText: turnState.lastAgentMessage || turnState.reviewText || "",
      reasoningSummary: turnState.reasoningSummary,
      stderr: cleanGeminiStderr(client.stderr || ""),
      error: turnState.error
    };
  });
}

// ---------------------------------------------------------------------------
// Public API — interruptGeminiTurn
// ---------------------------------------------------------------------------

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return { attempted: false, interrupted: false, detail: "Missing threadId or turnId." };
  }
  try {
    return await withAppServer(cwd, async (client) => {
      const result = await client.request("turn/interrupt", { threadId, turnId });
      return { attempted: true, ...result };
    });
  } catch (error) {
    return { attempted: true, interrupted: false, detail: error.message };
  }
}

// ---------------------------------------------------------------------------
// Public API — findLatestTaskThread
// ---------------------------------------------------------------------------

export async function findLatestTaskThread(cwd) {
  try {
    return await withAppServer(cwd, async (client) => {
      const response = await client.request("thread/list", {
        cwd,
        limit: 1,
        sortKey: "updated_at",
        sourceKinds: ["appServer"],
        searchTerm: TASK_THREAD_PREFIX
      });
      const thread = response?.data?.[0];
      return thread ? { id: thread.id } : null;
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API — parseStructuredOutput / readOutputSchema
// ---------------------------------------------------------------------------

export function parseStructuredOutput(rawMessage, meta = {}) {
  if (meta.status !== 0 && meta.failureMessage) {
    return { parsed: null, rawOutput: rawMessage ?? "", parseError: meta.failureMessage };
  }
  if (!rawMessage) {
    return { parsed: null, rawOutput: "", parseError: "Empty output." };
  }
  try {
    const parsed = JSON.parse(rawMessage);
    return { parsed, rawOutput: rawMessage, parseError: null };
  } catch {
    return { parsed: null, rawOutput: rawMessage, parseError: null };
  }
}

export function readOutputSchema(schemaPath) {
  try {
    return readJsonFile(schemaPath);
  } catch {
    return null;
  }
}

export function buildPersistentTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}
