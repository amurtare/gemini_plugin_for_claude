/**
 * Gemini App Server — JSON-RPC server wrapping `gemini -p` CLI calls.
 *
 * Implements the same protocol as the Codex App Server so that the existing
 * client code (app-server.mjs pattern) can connect without changes.
 *
 * Line-delimited JSON-RPC 2.0 over Unix sockets / Windows named pipes.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

const MAX_HISTORY_CHARS = 100_000;
const MAX_HISTORY_ENTRIES = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

function validateThreadId(threadId) {
  if (!threadId || !UUID_RE.test(threadId)) {
    throw Object.assign(
      new Error(`Invalid thread ID format: ${threadId}`),
      { code: -32602 }
    );
  }
}

// ---------------------------------------------------------------------------
// Thread persistence
// ---------------------------------------------------------------------------

function resolveThreadsDir(stateDir) {
  return path.join(stateDir, "threads");
}

function resolveThreadDir(stateDir, threadId) {
  validateThreadId(threadId);
  return path.join(resolveThreadsDir(stateDir), threadId);
}

function readThreadMetadata(stateDir, threadId) {
  const metaPath = path.join(resolveThreadDir(stateDir, threadId), "metadata.json");
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function writeThreadMetadata(stateDir, threadId, metadata) {
  const dir = resolveThreadDir(stateDir, threadId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(metadata, null, 2));
}

function appendHistoryEntry(stateDir, threadId, entry) {
  const dir = resolveThreadDir(stateDir, threadId);
  fs.mkdirSync(dir, { recursive: true });
  const historyPath = path.join(dir, "history.jsonl");

  // Enforce max entries to prevent unbounded disk growth (DoS)
  try {
    const existing = fs.readFileSync(historyPath, "utf8").trim();
    if (existing) {
      const lines = existing.split("\n");
      if (lines.length >= MAX_HISTORY_ENTRIES) {
        // Keep only the most recent half
        const trimmed = lines.slice(Math.floor(lines.length / 2));
        fs.writeFileSync(historyPath, trimmed.join("\n") + "\n");
      }
    }
  } catch {
    // File doesn't exist yet — that's fine
  }

  fs.appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
}

function readHistory(stateDir, threadId) {
  const historyPath = path.join(resolveThreadDir(stateDir, threadId), "history.jsonl");
  try {
    const content = fs.readFileSync(historyPath, "utf8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function listThreads(stateDir, options = {}) {
  const threadsDir = resolveThreadsDir(stateDir);
  if (!fs.existsSync(threadsDir)) return [];

  const dirs = fs.readdirSync(threadsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const threads = [];
  for (const id of dirs) {
    const meta = readThreadMetadata(stateDir, id);
    if (!meta) continue;
    if (options.cwd && meta.cwd !== options.cwd) continue;
    if (options.searchTerm && !meta.name?.includes(options.searchTerm)) continue;
    threads.push(meta);
  }

  threads.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  if (options.limit) {
    threads.length = Math.min(threads.length, options.limit);
  }
  return threads;
}

// ---------------------------------------------------------------------------
// Context assembly — build prompt from conversation history
// ---------------------------------------------------------------------------

/**
 * Sanitize history entry to prevent prompt injection.
 * Strips role-tag patterns that could confuse the model into treating
 * injected history content as new user/system instructions.
 */
function sanitizeHistoryContent(content) {
  return (content || "")
    .replace(/\[user\]\s*:/gi, "[prev-user]:")
    .replace(/\[assistant\]\s*:/gi, "[prev-assistant]:")
    .replace(/\[system\]\s*:/gi, "[prev-system]:")
    .replace(/<\/?system>/gi, "")
    .replace(/<\/?user>/gi, "")
    .replace(/<\/?assistant>/gi, "");
}

function buildConversationPrompt(history, newInput) {
  let historyText = "";
  let totalChars = 0;

  // Walk backwards to keep recent turns, summarize old ones
  const entries = [...history];
  const recentEntries = [];
  const oldEntries = [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const entryLen = (entry.content || "").length;
    if (totalChars + entryLen < MAX_HISTORY_CHARS) {
      recentEntries.unshift(entry);
      totalChars += entryLen;
    } else {
      oldEntries.unshift(...entries.slice(0, i + 1));
      break;
    }
  }

  if (oldEntries.length > 0) {
    const summaryParts = oldEntries.map((e) => {
      const role = e.role === "user" ? "user" : "assistant";
      return `<history-${role}>${sanitizeHistoryContent(e.content).slice(0, 200)}...</history-${role}>`;
    });
    historyText += `<previous-conversation-summary turns="${oldEntries.length}">\n${summaryParts.join("\n")}\n</previous-conversation-summary>\n\n`;
  }

  for (const entry of recentEntries) {
    const role = entry.role === "user" ? "user" : "assistant";
    historyText += `<history-${role}>${sanitizeHistoryContent(entry.content)}</history-${role}>\n\n`;
  }

  if (historyText) {
    return `<conversation-history>\n${historyText}</conversation-history>\n\n<current-request>\n${newInput}\n</current-request>`;
  }
  return newInput;
}

// ---------------------------------------------------------------------------
// Gemini REST API — direct fetch (fast path, no CLI boot overhead)
// ---------------------------------------------------------------------------

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";
const TOKEN_EXPIRY_BUFFER_MS = 60_000; // refresh 1 min before expiry

/**
 * Load credentials: API key (env) or OAuth token (disk).
 * Returns { type: "api-key", key } or { type: "oauth", accessToken } or null.
 */
function loadGeminiCredentials() {
  // Priority 1: API key from environment
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    return { type: "api-key", key: apiKey };
  }

  // Priority 2: OAuth token from disk
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (!homeDir) return null;

  const credsPath = path.join(homeDir, ".gemini", "oauth_creds.json");
  try {
    const raw = fs.readFileSync(credsPath, "utf8");
    const creds = JSON.parse(raw);
    if (!creds.access_token) return null;

    // Check expiry
    const now = Date.now();
    if (creds.expiry_date && now >= creds.expiry_date - TOKEN_EXPIRY_BUFFER_MS) {
      return null; // expired — caller should fall back to CLI
    }

    return { type: "oauth", accessToken: creds.access_token };
  } catch {
    return null;
  }
}

/**
 * Build the Gemini API URL for streaming.
 */
function buildAPIUrl(model, creds) {
  const modelId = model || DEFAULT_MODEL;
  const base = `${GEMINI_API_BASE}/models/${modelId}:streamGenerateContent`;

  if (creds.type === "api-key") {
    return `${base}?alt=sse&key=${encodeURIComponent(creds.key)}`;
  }
  return `${base}?alt=sse`;
}

/**
 * Build request headers.
 */
function buildAPIHeaders(creds) {
  const headers = { "Content-Type": "application/json" };

  if (creds.type === "oauth") {
    headers["Authorization"] = `Bearer ${creds.accessToken}`;
  }

  // Enterprise workspace may require project header
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (project) {
    headers["x-goog-user-project"] = project;
  }

  return headers;
}

/**
 * Build the Gemini API request body from a prompt string.
 */
function buildAPIBody(prompt) {
  return {
    contents: [{ parts: [{ text: prompt }] }]
  };
}

/**
 * Call Gemini REST API with SSE streaming, translating events to JSON-RPC notifications.
 * Returns { status, finalMessage, stderr, reasoningSummary }.
 */
async function callGeminiAPIStream(prompt, model, creds, threadId, turnId, emit) {
  const url = buildAPIUrl(model, creds);
  const headers = buildAPIHeaders(creds);
  const body = buildAPIBody(prompt);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  // Emit turn/started
  emit({
    method: "turn/started",
    params: { threadId, turnId, turn: { id: turnId, status: "inProgress" } }
  });

  // Parse SSE stream
  let finalMessage = "";
  let itemCounter = 0;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE events
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;

      let chunk;
      try {
        chunk = JSON.parse(jsonStr);
      } catch {
        continue;
      }

      // Extract text from candidates
      const candidates = chunk.candidates || [];
      for (const candidate of candidates) {
        const parts = candidate.content?.parts || [];
        for (const part of parts) {
          if (part.text) {
            finalMessage += part.text;
          }
        }

        // Check for finish reason
        if (candidate.finishReason && candidate.finishReason !== "STOP") {
          // Non-normal finish
        }
      }

      // Extract usage metadata if present
      if (chunk.usageMetadata) {
        // Available for stats but not needed for notification flow
      }
    }
  }

  // Emit final message
  if (finalMessage) {
    const itemId = `item-${++itemCounter}`;
    emit({
      method: "item/completed",
      params: {
        threadId, turnId, itemId,
        item: { type: "agentMessage", text: finalMessage, phase: "final_answer" }
      }
    });
  }

  // Emit turn/completed
  emit({
    method: "turn/completed",
    params: {
      threadId, turnId,
      turn: { id: turnId, status: "completed", stats: {} }
    }
  });

  return { status: 0, finalMessage, stderr: "", reasoningSummary: [] };
}

// ---------------------------------------------------------------------------
// Gemini CLI spawner (fallback when REST API unavailable)
// ---------------------------------------------------------------------------

function buildGeminiArgs(prompt, options = {}) {
  const args = ["-p", prompt, "--output-format", "stream-json"];

  if (options.model) {
    args.push("-m", options.model);
  }

  if (options.sandbox === "workspace-write") {
    args.push("--approval-mode", "auto_edit");
  }

  return args;
}

/**
 * Spawn `gemini -p` and return a controller for the running process.
 */
/**
 * Build a minimal environment for the Gemini CLI process.
 * Only passes through PATH and auth-related variables to avoid
 * leaking sensitive enterprise env vars (DB passwords, internal tokens, etc.).
 */
function buildSafeEnv(extraEnv = {}) {
  const safe = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    // Display
    NO_COLOR: "1",
    ...extraEnv
  };

  // Pass through all GOOGLE_* and GEMINI_* env vars for auth/config
  for (const [key, value] of Object.entries(process.env)) {
    if ((key.startsWith("GOOGLE_") || key.startsWith("GEMINI_")) && value) {
      safe[key] = value;
    }
  }

  // Remove undefined values
  for (const key of Object.keys(safe)) {
    if (safe[key] === undefined) delete safe[key];
  }
  return safe;
}

function spawnGeminiProcess(prompt, options = {}) {
  const args = buildGeminiArgs(prompt, options);
  const env = buildSafeEnv(options.env);

  // On Windows, npm-installed CLIs are .cmd wrappers that require shell.
  // We use process.execPath (node) to run the actual JS entry point directly,
  // which avoids both shell:true security issues and .cmd limitations.
  let binary = "gemini";
  let spawnArgs = args;
  let useShell = false;

  if (process.platform === "win32") {
    // Find the actual JS entry point behind gemini.cmd
    const npmGlobalDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm")
      : null;
    const geminiJsPath = npmGlobalDir
      ? path.join(npmGlobalDir, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js")
      : null;

    if (geminiJsPath && fs.existsSync(geminiJsPath)) {
      // Spawn node directly with the CLI entry point
      binary = process.execPath;
      spawnArgs = [geminiJsPath, ...args];
    } else {
      // Fallback: use gemini.cmd with shell (less ideal but works)
      useShell = true;
    }
  }

  const proc = spawn(binary, spawnArgs, {
    cwd: options.cwd || process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: useShell,
    windowsHide: true
  });

  return proc;
}

// ---------------------------------------------------------------------------
// Gemini stream-json → JSON-RPC notification translator
// ---------------------------------------------------------------------------

/**
 * @param {import("readline").Interface} rl
 * @param {string} threadId
 * @param {string} turnId
 * @param {(notification: object) => void} emit
 * @returns {Promise<{status: number, finalMessage: string, stderr: string, reasoningSummary: string[]}>}
 */
function createStreamTranslator(rl, threadId, turnId, emit) {
  return new Promise((resolve) => {
    let finalMessage = "";
    let stderr = "";
    const reasoningSummary = [];
    let itemCounter = 0;
    let currentMessageText = "";

    rl.on("line", (line) => {
      if (!line.trim()) return;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      const eventType = event.type || event.event;

      switch (eventType) {
        case "init": {
          emit({
            method: "turn/started",
            params: {
              threadId,
              turnId,
              turn: { id: turnId, status: "inProgress" }
            }
          });
          break;
        }

        case "message": {
          const text = event.content || event.delta || event.message || "";
          const role = event.role || "assistant";

          if (role === "assistant") {
            currentMessageText += text;

            if (event.delta) {
              // Streaming delta — accumulate, don't emit item yet
            } else {
              // Complete message
              const itemId = `item-${++itemCounter}`;
              emit({
                method: "item/completed",
                params: {
                  threadId,
                  turnId,
                  itemId,
                  item: {
                    type: "agentMessage",
                    text: currentMessageText || text,
                    phase: "assistant"
                  }
                }
              });
              currentMessageText = "";
            }
          }
          break;
        }

        case "tool_use": {
          const itemId = `item-${++itemCounter}`;
          const toolName = event.name || event.tool || "unknown";
          const toolArgs = event.arguments || event.args || {};

          // Detect file changes vs shell commands
          if (toolName === "write_file" || toolName === "replace") {
            emit({
              method: "item/started",
              params: {
                threadId,
                turnId,
                itemId,
                item: {
                  type: "fileChange",
                  changes: [{ path: toolArgs.path || toolArgs.file || "unknown" }]
                }
              }
            });
          } else if (toolName === "run_shell_command") {
            emit({
              method: "item/started",
              params: {
                threadId,
                turnId,
                itemId,
                item: {
                  type: "commandExecution",
                  command: toolArgs.command || String(toolArgs),
                  status: "running"
                }
              }
            });
          } else {
            emit({
              method: "item/started",
              params: {
                threadId,
                turnId,
                itemId,
                item: {
                  type: "mcpToolCall",
                  tool: toolName,
                  status: "running"
                }
              }
            });
          }
          break;
        }

        case "tool_result": {
          const itemId = `item-${++itemCounter}`;
          const toolName = event.name || event.tool || "unknown";
          const output = event.output || event.result || "";
          const exitCode = event.exitCode ?? 0;

          if (toolName === "write_file" || toolName === "replace") {
            emit({
              method: "item/completed",
              params: {
                threadId,
                turnId,
                itemId,
                item: {
                  type: "fileChange",
                  changes: [{ path: event.path || "unknown" }]
                }
              }
            });
          } else if (toolName === "run_shell_command") {
            emit({
              method: "item/completed",
              params: {
                threadId,
                turnId,
                itemId,
                item: {
                  type: "commandExecution",
                  command: event.command || toolName,
                  exitCode,
                  status: exitCode === 0 ? "completed" : "failed"
                }
              }
            });
          } else {
            emit({
              method: "item/completed",
              params: {
                threadId,
                turnId,
                itemId,
                item: {
                  type: "mcpToolCall",
                  tool: toolName,
                  status: "completed"
                }
              }
            });
          }
          break;
        }

        case "result": {
          finalMessage = event.response || currentMessageText || "";
          const stats = event.stats || {};

          // Emit final message if not already emitted
          if (finalMessage && currentMessageText) {
            const itemId = `item-${++itemCounter}`;
            emit({
              method: "item/completed",
              params: {
                threadId,
                turnId,
                itemId,
                item: {
                  type: "agentMessage",
                  text: finalMessage,
                  phase: "final_answer"
                }
              }
            });
          }

          // Emit turn completed
          emit({
            method: "turn/completed",
            params: {
              threadId,
              turnId,
              turn: {
                id: turnId,
                status: "completed",
                stats
              }
            }
          });
          break;
        }

        case "error": {
          stderr += (event.message || event.error || JSON.stringify(event)) + "\n";
          break;
        }
      }
    });

    rl.on("close", () => {
      // If no result event was received, emit turn/completed
      if (!finalMessage) {
        finalMessage = currentMessageText || "";
        emit({
          method: "turn/completed",
          params: {
            threadId,
            turnId,
            turn: {
              id: turnId,
              status: finalMessage ? "completed" : "failed"
            }
          }
        });
      }
      resolve({ status: stderr ? 1 : 0, finalMessage, stderr, reasoningSummary });
    });
  });
}

// ---------------------------------------------------------------------------
// GeminiAppServer — the JSON-RPC request handler
// ---------------------------------------------------------------------------

export class GeminiAppServer {
  constructor(stateDir, options = {}) {
    this.stateDir = stateDir;
    this.options = options;
    /** @type {Map<string, import("child_process").ChildProcess>} threadId → running gemini process */
    this.activeProcesses = new Map();
    this.initialized = false;
  }

  /**
   * Handle a JSON-RPC request and return the result.
   * @param {string} method
   * @param {object} params
   * @param {(notification: object) => void} emit — callback to send notifications
   * @returns {Promise<object>}
   */
  async handleRequest(method, params, emit) {
    switch (method) {
      case "initialize":
        return this.handleInitialize(params);
      case "thread/start":
        return this.handleThreadStart(params);
      case "thread/resume":
        return this.handleThreadResume(params);
      case "thread/name/set":
        return this.handleThreadNameSet(params);
      case "thread/list":
        return this.handleThreadList(params);
      case "turn/start":
        return this.handleTurnStart(params, emit);
      case "turn/interrupt":
        return this.handleTurnInterrupt(params);
      case "review/start":
        return this.handleReviewStart(params, emit);
      default:
        throw Object.assign(new Error(`Unknown method: ${method}`), { code: -32601 });
    }
  }

  handleInitialize(params) {
    this.initialized = true;
    this.clientInfo = params.clientInfo;
    return {
      serverInfo: {
        name: "gemini-app-server",
        version: "0.1.0"
      },
      capabilities: {}
    };
  }

  handleThreadStart(params) {
    const threadId = randomUUID();
    const now = new Date().toISOString();
    const metadata = {
      id: threadId,
      name: null,
      cwd: params.cwd || process.cwd(),
      model: params.model || null,
      sandbox: params.sandbox || "read-only",
      serviceName: params.serviceName || "claude_code_gemini_plugin",
      ephemeral: params.ephemeral ?? true,
      createdAt: now,
      updatedAt: now
    };
    writeThreadMetadata(this.stateDir, threadId, metadata);
    return { thread: { id: threadId, name: null } };
  }

  handleThreadResume(params) {
    const { threadId } = params;
    const metadata = readThreadMetadata(this.stateDir, threadId);
    if (!metadata) {
      throw Object.assign(new Error(`Thread ${threadId} not found.`), { code: -32602 });
    }

    // Update model/sandbox if provided
    if (params.model) metadata.model = params.model;
    if (params.sandbox) metadata.sandbox = params.sandbox;
    if (params.cwd) metadata.cwd = params.cwd;
    metadata.updatedAt = new Date().toISOString();
    writeThreadMetadata(this.stateDir, threadId, metadata);

    return { thread: { id: threadId, name: metadata.name } };
  }

  handleThreadNameSet(params) {
    const { threadId, name } = params;
    const metadata = readThreadMetadata(this.stateDir, threadId);
    if (!metadata) {
      throw Object.assign(new Error(`Thread ${threadId} not found.`), { code: -32602 });
    }
    metadata.name = name;
    metadata.updatedAt = new Date().toISOString();
    writeThreadMetadata(this.stateDir, threadId, metadata);
    return { threadId, name };
  }

  handleThreadList(params) {
    const threads = listThreads(this.stateDir, {
      cwd: params.cwd,
      limit: params.limit,
      searchTerm: params.searchTerm
    });
    return { data: threads };
  }

  async handleTurnStart(params, emit) {
    const { threadId, input, model, effort, outputSchema } = params;
    const metadata = readThreadMetadata(this.stateDir, threadId);
    if (!metadata) {
      throw Object.assign(new Error(`Thread ${threadId} not found.`), { code: -32602 });
    }

    const turnId = randomUUID();
    const userText = (input || [])
      .filter((i) => i.type === "text")
      .map((i) => i.text)
      .join("\n");

    if (!userText) {
      throw Object.assign(new Error("No text input provided."), { code: -32602 });
    }

    // Build prompt with conversation history
    const history = readHistory(this.stateDir, threadId);
    const fullPrompt = buildConversationPrompt(history, userText);

    // Resolve options
    const resolvedModel = model || metadata.model;
    const sandbox = metadata.sandbox;

    // Append user turn to history
    appendHistoryEntry(this.stateDir, threadId, {
      role: "user",
      content: userText,
      timestamp: new Date().toISOString()
    });

    // Try REST API first (fast path), fall back to CLI spawn
    const creds = loadGeminiCredentials();
    const canUseAPI = creds && sandbox !== "workspace-write"; // API can't do file edits

    if (canUseAPI) {
      // Fast path: direct REST API call
      const apiPromise = callGeminiAPIStream(fullPrompt, resolvedModel, creds, threadId, turnId, emit)
        .then((apiResult) => {
          if (apiResult.finalMessage) {
            appendHistoryEntry(this.stateDir, threadId, {
              role: "assistant",
              content: apiResult.finalMessage,
              timestamp: new Date().toISOString()
            });
          }
          metadata.updatedAt = new Date().toISOString();
          writeThreadMetadata(this.stateDir, threadId, metadata);
        })
        .catch((apiError) => {
          // API failed — fall back to CLI spawn
          this._spawnCliFallback(threadId, turnId, fullPrompt, resolvedModel, sandbox, metadata, emit);
        });

      return { turn: { id: turnId, status: "inProgress" } };
    }

    // Slow path: CLI spawn (for write mode or when no credentials)
    this._spawnCliFallback(threadId, turnId, fullPrompt, resolvedModel, sandbox, metadata, emit);
    return { turn: { id: turnId, status: "inProgress" } };
  }

  /** @private CLI spawn fallback — used when REST API is unavailable */
  _spawnCliFallback(threadId, turnId, fullPrompt, resolvedModel, sandbox, metadata, emit) {
    const proc = spawnGeminiProcess(fullPrompt, {
      cwd: metadata.cwd,
      model: resolvedModel,
      sandbox,
      env: this.options.env
    });

    this.activeProcesses.set(threadId, proc);

    const rl = readline.createInterface({ input: proc.stdout });
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    let stderrContent = "";
    proc.stderr.on("data", (chunk) => {
      stderrContent += chunk;
    });

    const translationPromise = createStreamTranslator(rl, threadId, turnId, emit);

    translationPromise.then((translationResult) => {
      this.activeProcesses.delete(threadId);

      if (translationResult.finalMessage) {
        appendHistoryEntry(this.stateDir, threadId, {
          role: "assistant",
          content: translationResult.finalMessage,
          timestamp: new Date().toISOString()
        });
      }

      metadata.updatedAt = new Date().toISOString();
      writeThreadMetadata(this.stateDir, threadId, metadata);
    });
  }

  async handleTurnInterrupt(params) {
    const { threadId, turnId } = params;
    const proc = this.activeProcesses.get(threadId);
    if (!proc) {
      return { interrupted: false, detail: "No active process for this thread." };
    }

    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true
        });
      } else {
        proc.kill("SIGTERM");
      }
      this.activeProcesses.delete(threadId);
      return { interrupted: true };
    } catch (error) {
      return { interrupted: false, detail: error.message };
    }
  }

  async handleReviewStart(params, emit) {
    // Gemini has no native review — delegate to turn/start with review prompt
    const threadResult = this.handleThreadStart({
      cwd: params.cwd,
      model: params.model,
      sandbox: "read-only",
      serviceName: "claude_code_gemini_plugin",
      ephemeral: true
    });

    const reviewPrompt = buildReviewPrompt(params.reviewTarget);
    const turnResult = await this.handleTurnStart(
      {
        threadId: threadResult.thread.id,
        input: [{ type: "text", text: reviewPrompt, text_elements: [] }],
        model: params.model
      },
      emit
    );

    return {
      reviewThreadId: threadResult.thread.id,
      turn: turnResult.turn
    };
  }

  shutdown() {
    for (const [threadId, proc] of this.activeProcesses) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true
          });
        } else {
          proc.kill("SIGTERM");
        }
      } catch {
        // Best-effort cleanup
      }
    }
    this.activeProcesses.clear();
  }
}

// ---------------------------------------------------------------------------
// Helper: build review prompt from target info
// ---------------------------------------------------------------------------

function buildReviewPrompt(reviewTarget) {
  if (!reviewTarget) {
    return "Review the current code changes for bugs, security issues, and best practice violations. Provide structured feedback.";
  }

  if (reviewTarget.type === "uncommittedChanges") {
    return "Review the uncommitted changes in this repository for bugs, security issues, performance problems, and best practice violations. Provide a thorough code review with specific file references and line numbers.";
  }

  if (reviewTarget.type === "baseBranch") {
    return `Review all changes on the current branch compared to ${reviewTarget.branch}. Look for bugs, security issues, performance problems, and best practice violations. Provide a thorough code review with specific file references and line numbers.`;
  }

  return "Review the current code changes. Provide structured feedback on any issues found.";
}
