/**
 * ACP process lifecycle management.
 *
 * Handles spawning `gemini --acp`, detecting the correct flag,
 * creating/resuming sessions, and health checks.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { AcpClient } from "./acp-client.mjs";

const ACP_INIT_TIMEOUT_MS = 15_000;

let _cachedAcpFlag = null;

// ---------------------------------------------------------------------------
// Environment — reuse the safe env pattern from gemini-server.mjs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Binary resolution (same pattern as gemini-server.mjs)
// ---------------------------------------------------------------------------

function resolveGeminiBinary() {
  if (process.platform === "win32") {
    const npmGlobal = process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js")
      : null;
    if (npmGlobal && fs.existsSync(npmGlobal)) {
      return { binary: process.execPath, prefix: [npmGlobal] };
    }
    return { binary: "gemini", prefix: [], shell: true };
  }
  return { binary: "gemini", prefix: [], shell: false };
}

// ---------------------------------------------------------------------------
// ACP flag detection
// ---------------------------------------------------------------------------

export function detectAcpFlag(binary = "gemini") {
  if (_cachedAcpFlag) return _cachedAcpFlag;

  try {
    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      shell: process.platform === "win32"
    });

    const version = (result.stdout || "").trim();
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (match) {
      const [, major, minor] = match.map(Number);
      _cachedAcpFlag = (major === 0 && minor < 33) ? "--experimental-acp" : "--acp";
    } else {
      _cachedAcpFlag = "--acp";
    }
  } catch {
    _cachedAcpFlag = "--acp";
  }

  return _cachedAcpFlag;
}

// ---------------------------------------------------------------------------
// Spawn ACP client
// ---------------------------------------------------------------------------

export async function spawnAcpClient(opts = {}) {
  const { binary, prefix, shell } = resolveGeminiBinary();
  const flag = detectAcpFlag(binary === process.execPath ? "gemini" : binary);
  const args = [...prefix, flag];
  const env = buildSafeEnv(opts.env);

  const proc = spawn(binary, args, {
    cwd: opts.cwd || process.cwd(),
    env,
    stdio: ["pipe", "pipe", "inherit"],
    shell: shell || false,
    windowsHide: true
  });

  const client = new AcpClient(proc);

  // Install default server request handlers
  installDefaultHandlers(client);

  // Initialize with timeout
  const initTimeout = opts.timeoutMs || ACP_INIT_TIMEOUT_MS;
  await Promise.race([
    client.initialize(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`ACP initialize timed out after ${initTimeout}ms`)), initTimeout)
    )
  ]);

  return client;
}

// ---------------------------------------------------------------------------
// Default handlers for server-initiated requests
// ---------------------------------------------------------------------------

function installDefaultHandlers(client) {
  // File read requests — deny by default for security
  client.onServerRequest("read_text_file", (params) => {
    return { content: "", error: "File read denied by plugin security policy." };
  });

  // File write requests — deny by default (only allow when explicitly in write mode)
  client.onServerRequest("write_text_file", (params) => {
    return { error: "File write denied by plugin security policy." };
  });

  // Permission expansion requests — deny by default
  client.onServerRequest("sandbox/expand", (params) => {
    return { approved: false, reason: "Sandbox expansion denied by plugin security policy." };
  });
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export async function createSession(opts = {}) {
  const client = await spawnAcpClient(opts);
  const { sessionId } = await client.newSession(opts.cwd || process.cwd(), []);

  if (opts.modeId) {
    await client.setMode(sessionId, opts.modeId);
  }
  if (opts.model) {
    await client.setModel(sessionId, opts.model);
  }

  return { client, sessionId };
}

export async function resumeSession(sessionId, opts = {}) {
  const client = await spawnAcpClient(opts);
  await client.loadSession(sessionId, opts.cwd || process.cwd());

  if (opts.model) {
    await client.setModel(sessionId, opts.model);
  }

  return { client, sessionId };
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export function isAlive(client) {
  if (!client || client.exited) return false;
  try {
    process.kill(client.pid, 0); // Signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}
