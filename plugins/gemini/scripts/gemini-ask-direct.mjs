#!/usr/bin/env node

/**
 * Lightweight direct Gemini CLI caller for /gemini:ask.
 * Bypasses the full broker/daemon/thread stack for simple Q&A.
 * Spawns gemini -p directly and prints the response text.
 *
 * Usage: node gemini-ask-direct.mjs [--model <model>] <prompt>
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { DEFAULT_MODEL, resolveModel } from "./lib/models.mjs";

function resolveGeminiBinary() {
  if (process.platform === "win32") {
    const npmGlobal = process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js")
      : null;
    if (npmGlobal && fs.existsSync(npmGlobal)) {
      return { binary: process.execPath, prefix: [npmGlobal] };
    }
    // Fallback to shell
    return { binary: "gemini", prefix: [], shell: true };
  }
  return { binary: "gemini", prefix: [], shell: false };
}

async function main() {
  const args = process.argv.slice(2);
  let model = DEFAULT_MODEL;
  const promptParts = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--model" || args[i] === "-m") && i + 1 < args.length) {
      model = resolveModel(args[++i]) || DEFAULT_MODEL;
    } else {
      promptParts.push(args[i]);
    }
  }

  const prompt = promptParts.join(" ");
  if (!prompt) {
    process.stderr.write("Usage: gemini-ask-direct.mjs [--model <model>] <prompt>\n");
    process.exitCode = 1;
    return;
  }

  const { binary, prefix, shell } = resolveGeminiBinary();
  const geminiArgs = [...prefix, "-p", prompt, "-m", model, "--output-format", "json"];

  // Filtered env — avoid leaking sensitive enterprise env vars
  const safeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      key.startsWith("GOOGLE_") || key.startsWith("GEMINI_") ||
      ["PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA",
       "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP", "LANG"
      ].includes(key)
    )
  );
  safeEnv.NO_COLOR = "1";

  const proc = spawn(binary, geminiArgs, {
    cwd: process.cwd(),
    env: safeEnv,
    stdio: ["pipe", "pipe", "pipe"],
    shell: shell || false,
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => { stdout += chunk; });
  proc.stderr.on("data", (chunk) => { stderr += chunk; });

  const exitCode = await new Promise((resolve) => {
    proc.on("error", (err) => {
      process.stderr.write(`Failed to start gemini: ${err.message}\n`);
      resolve(1);
    });
    proc.on("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    // Filter noise from stderr
    const cleanStderr = stderr.split("\n")
      .filter((l) => l.trim() && !l.includes("DEP0190") && !l.includes("DeprecationWarning"))
      .join("\n");
    if (cleanStderr) process.stderr.write(cleanStderr + "\n");
    process.exitCode = exitCode;
    return;
  }

  // Parse JSON output and extract response text
  try {
    const data = JSON.parse(stdout);
    const responseText = data.response || stdout;
    process.stdout.write(responseText);
  } catch {
    // Not JSON — print as-is
    process.stdout.write(stdout);
  }
}

main().catch(async (error) => {
  const { classifyError, formatError } = await import("./lib/errors.mjs");
  const structured = classifyError(error);
  process.stderr.write(`${formatError(structured)}\n`);
  process.exitCode = 1;
});
