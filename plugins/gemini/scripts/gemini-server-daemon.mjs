#!/usr/bin/env node

/**
 * Gemini App Server daemon — listens on a Unix socket / Windows named pipe
 * and handles JSON-RPC requests using the GeminiAppServer.
 *
 * Unlike the Codex broker which connects to `codex app-server` as a backend,
 * this daemon IS the app server — it directly spawns `gemini -p` processes.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/shared.mjs";
import { GeminiAppServer } from "./lib/gemini-server.mjs";

const BROKER_BUSY_RPC_CODE = -32001;
const STREAMING_METHODS = new Set(["turn/start", "review/start"]);

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function parseBrokerEndpoint(endpoint) {
  if (endpoint.startsWith("pipe:")) {
    return { kind: "pipe", path: endpoint.slice(5) };
  }
  if (endpoint.startsWith("unix:")) {
    return { kind: "unix", path: endpoint.slice(5) };
  }
  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error(
      "Usage: node scripts/gemini-server-daemon.mjs serve --endpoint <value> --state-dir <path> [--cwd <path>] [--pid-file <path>]"
    );
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint", "state-dir"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const stateDir = options["state-dir"]
    ? path.resolve(options["state-dir"])
    : path.join(cwd, ".gemini-companion");

  writePidFile(pidFile);

  // Create the Gemini app server
  const appServer = new GeminiAppServer(stateDir);

  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  async function shutdown(server) {
    appServer.shutdown();
    for (const socket of sockets) {
      socket.end();
    }
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        // Handle initialize locally (broker handshake)
        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              serverInfo: { name: "gemini-companion-broker", version: "0.1.0" },
              capabilities: {}
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        // Handle broker/shutdown
        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        // Concurrency control — only one streaming client at a time
        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) &&
          activeStreamSocket &&
          activeStreamSocket !== socket &&
          !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) ||
            (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Gemini broker is busy.")
          });
          continue;
        }

        // Allow interrupt passthrough
        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appServer.handleRequest(message.method, message.params ?? {}, (n) =>
              send(socket, n)
            );
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.code ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        // Route notifications for streaming methods to the requesting socket
        const emitNotification = (notification) => {
          send(socket, notification);

          // Release ownership on turn/completed
          if (notification.method === "turn/completed") {
            const threadId = notification.params?.threadId ?? null;
            if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
              if (activeStreamSocket === socket) {
                activeStreamSocket = null;
                activeStreamThreadIds = null;
              }
              if (activeRequestSocket === socket) {
                activeRequestSocket = null;
              }
            }
          }
        };

        try {
          const result = await appServer.handleRequest(
            message.method,
            message.params ?? {},
            emitNotification
          );
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket && !isStreaming) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.code ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path, () => {
    // Restrict socket file permissions to owner-only (Unix)
    if (listenTarget.kind === "unix") {
      try {
        fs.chmodSync(listenTarget.path, 0o600);
      } catch {
        // Best-effort — Windows named pipes don't use chmod
      }
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
