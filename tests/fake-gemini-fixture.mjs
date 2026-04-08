import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

/**
 * Installs a fake `gemini` CLI that simulates `gemini -p` with `--output-format stream-json`.
 *
 * This fixture emits JSONL events that the Gemini App Server expects to parse.
 */
export function installFakeGemini(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-gemini-state.json");
  const scriptPath = path.join(binDir, "gemini");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { calls: 0 };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function emitEvent(type, data = {}) {
  const event = { type, ...data };
  process.stdout.write(JSON.stringify(event) + "\\n");
}

function handlePrompt(args) {
  const state = loadState();
  state.calls++;
  saveState(state);

  // Check for --version
  if (args.includes("--version")) {
    process.stdout.write("gemini-cli 1.0.0-fake\\n");
    return;
  }

  // Extract prompt from -p flag
  const pIndex = args.indexOf("-p");
  const prompt = pIndex >= 0 && pIndex + 1 < args.length ? args[pIndex + 1] : "";

  // Check output format
  const formatIndex = args.indexOf("--output-format");
  const format = formatIndex >= 0 && formatIndex + 1 < args.length ? args[formatIndex + 1] : "text";

  if (format === "json") {
    // Simple JSON output
    const response = getResponse(prompt);
    process.stdout.write(JSON.stringify({
      response: response,
      stats: {
        models: { "gemini-2.5-pro": { totalRequests: 1, tokenCounts: { prompt: 100, candidates: 200, total: 300 } } },
        tools: { totalCalls: 0, totalSuccess: 0 },
        files: { totalLinesAdded: 0, totalLinesRemoved: 0 }
      }
    }) + "\\n");
    return;
  }

  if (format === "stream-json") {
    // Emit streaming JSONL events
    emitEvent("init", { session_id: "fake-session-1", model: "gemini-2.5-pro" });

    if (BEHAVIOR === "review-ok") {
      const reviewOutput = {
        verdict: "approve",
        summary: "No issues found in the reviewed changes.",
        findings: [],
        next_steps: []
      };
      emitEvent("message", {
        role: "assistant",
        content: JSON.stringify(reviewOutput)
      });
    } else if (BEHAVIOR === "review-issues") {
      const reviewOutput = {
        verdict: "needs-attention",
        summary: "Found potential security issue.",
        findings: [{
          severity: "high",
          title: "SQL injection risk",
          body: "User input is concatenated directly into SQL query.",
          file: "src/db.js",
          line_start: 42,
          line_end: 42,
          confidence: 0.9,
          recommendation: "Use parameterized queries."
        }],
        next_steps: ["Fix SQL injection vulnerability"]
      };
      emitEvent("message", {
        role: "assistant",
        content: JSON.stringify(reviewOutput)
      });
    } else if (BEHAVIOR === "task-ok") {
      emitEvent("message", {
        role: "assistant",
        content: "I've analyzed the code and fixed the issue. The test should now pass."
      });
      emitEvent("tool_use", { name: "write_file", arguments: { path: "src/fix.js", content: "// fixed" } });
      emitEvent("tool_result", { name: "write_file", output: "File written successfully", path: "src/fix.js" });
    } else if (BEHAVIOR === "error") {
      emitEvent("error", { message: "API rate limit exceeded" });
    } else {
      emitEvent("message", {
        role: "assistant",
        content: "Task completed successfully."
      });
    }

    emitEvent("result", {
      response: getResponse(prompt),
      stats: {
        models: { "gemini-2.5-pro": { totalRequests: 1, tokenCounts: { prompt: 100, candidates: 200, total: 300 } } },
        tools: { totalCalls: 0, totalSuccess: 0 },
        files: { totalLinesAdded: 0, totalLinesRemoved: 0 }
      }
    });
    return;
  }

  // Plain text output
  process.stdout.write(getResponse(prompt) + "\\n");
}

function getResponse(prompt) {
  if (BEHAVIOR === "review-ok") {
    return JSON.stringify({
      verdict: "approve",
      summary: "No issues found.",
      findings: [],
      next_steps: []
    });
  }
  if (BEHAVIOR === "task-ok") {
    return "Task completed. Fixed the failing test.";
  }
  if (BEHAVIOR === "error") {
    process.exitCode = 1;
    return "Error: API rate limit exceeded";
  }
  return "Gemini response for: " + prompt;
}

handlePrompt(process.argv.slice(2));
`;

  writeExecutable(scriptPath, source);
  return { scriptPath, statePath };
}

export function readFakeGeminiState(binDir) {
  const statePath = path.join(binDir, "fake-gemini-state.json");
  if (!fs.existsSync(statePath)) {
    return { calls: 0 };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}
