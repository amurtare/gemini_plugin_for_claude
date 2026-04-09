/**
 * ACP (Agent Client Protocol) client for Gemini CLI.
 *
 * Communicates with a persistent `gemini --acp` process via JSON-RPC 2.0 over stdio.
 * The process stays alive across multiple requests, eliminating CLI boot overhead.
 */

import readline from "node:readline";

export class AcpClient {
  /** @param {import("child_process").ChildProcess} proc */
  constructor(proc) {
    this.proc = proc;
    this.pid = proc.pid;
    this.exited = false;
    this._pending = new Map();
    this._nextId = 1;
    this._updateHandlers = [];
    this._serverRequestHandlers = {};

    proc.stdout.setEncoding("utf8");
    this._rl = readline.createInterface({ input: proc.stdout });
    this._rl.on("line", (line) => this._handleLine(line));

    proc.on("exit", () => {
      this.exited = true;
      // Reject all pending requests
      for (const { reject } of this._pending.values()) {
        reject(new Error("ACP process exited."));
      }
      this._pending.clear();
    });

    proc.on("error", (err) => {
      this.exited = true;
      for (const { reject } of this._pending.values()) {
        reject(err);
      }
      this._pending.clear();
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async initialize() {
    return this._sendRequest("initialize", {
      clientInfo: { name: "gemini-plugin-for-claude", version: "0.2.0" },
      capabilities: {}
    });
  }

  async newSession(cwd, args = []) {
    return this._sendRequest("session/new", { cwd, args });
  }

  async loadSession(sessionId, cwd) {
    return this._sendRequest("session/load", { sessionId, cwd });
  }

  async prompt(sessionId, input) {
    return this._sendRequest("session/prompt", { sessionId, input });
  }

  async setMode(sessionId, modeId) {
    return this._sendRequest("session/set-mode", { sessionId, modeId });
  }

  async setModel(sessionId, model) {
    return this._sendRequest("session/set-model", { sessionId, model });
  }

  async cancel(sessionId) {
    return this._sendRequest("cancel", { sessionId });
  }

  onUpdate(handler) {
    this._updateHandlers.push(handler);
  }

  onServerRequest(method, handler) {
    this._serverRequestHandlers[method] = handler;
  }

  async shutdown() {
    if (this.exited) return;

    try {
      this.proc.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (!this.exited) {
        this.proc.kill("SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch {
      // Process already gone
    }

    if (this._rl) {
      this._rl.close();
    }

    // Clean up remaining pending
    for (const { reject } of this._pending.values()) {
      reject(new Error("ACP client shut down."));
    }
    this._pending.clear();
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC transport
  // ---------------------------------------------------------------------------

  _sendRequest(method, params = {}) {
    if (this.exited) {
      return Promise.reject(new Error("ACP process is not running."));
    }

    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.proc.stdin.write(message + "\n");
    });
  }

  _sendResponse(id, result) {
    if (this.exited) return;
    const message = JSON.stringify({ jsonrpc: "2.0", id, result });
    this.proc.stdin.write(message + "\n");
  }

  _sendErrorResponse(id, code, message) {
    if (this.exited) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
    this.proc.stdin.write(msg + "\n");
  }

  _handleLine(line) {
    if (!line.trim()) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Response to our request (has id, no method)
    if (msg.id !== undefined && !msg.method) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);

      if (msg.error) {
        const err = new Error(msg.error.message || `ACP ${pending.method} failed`);
        err.code = msg.error.code;
        pending.reject(err);
      } else {
        pending.resolve(msg.result ?? {});
      }
      return;
    }

    // Server request (has both id and method) — needs response
    if (msg.id !== undefined && msg.method) {
      const handler = this._serverRequestHandlers[msg.method];
      if (handler) {
        try {
          const result = handler(msg.params ?? {});
          this._sendResponse(msg.id, result ?? {});
        } catch (err) {
          this._sendErrorResponse(msg.id, -32000, err.message);
        }
      } else {
        // Default: deny unknown requests
        this._sendErrorResponse(msg.id, -32601, `Unsupported: ${msg.method}`);
      }
      return;
    }

    // Notification (has method, no id)
    if (msg.method) {
      for (const handler of this._updateHandlers) {
        try {
          handler(msg);
        } catch {
          // Swallow handler errors
        }
      }
    }
  }
}
