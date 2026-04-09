#!/usr/bin/env node

/**
 * Lightweight direct Gemini API caller for /gemini:ask.
 * Bypasses the full broker/daemon/thread stack for simple Q&A.
 *
 * Usage: node gemini-ask-direct.mjs [--model <model>] <prompt>
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function loadCredentials() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) return { type: "api-key", key: apiKey };

  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (!homeDir) return null;

  try {
    const raw = fs.readFileSync(path.join(homeDir, ".gemini", "oauth_creds.json"), "utf8");
    const creds = JSON.parse(raw);
    if (!creds.access_token) return null;
    if (creds.expiry_date && Date.now() >= creds.expiry_date - TOKEN_EXPIRY_BUFFER_MS) return null;
    return { type: "oauth", accessToken: creds.access_token };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

async function callGemini(prompt, model) {
  const creds = loadCredentials();
  if (!creds) {
    throw new Error("No valid Gemini credentials. Set GEMINI_API_KEY or run `gemini` to authenticate.");
  }

  const modelId = model || DEFAULT_MODEL;
  let url = `${GEMINI_API_BASE}/models/${modelId}:generateContent`;
  const headers = { "Content-Type": "application/json" };

  if (creds.type === "api-key") {
    url += `?key=${encodeURIComponent(creds.key)}`;
  } else {
    headers["Authorization"] = `Bearer ${creds.accessToken}`;
  }

  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (project) {
    headers["x-goog-user-project"] = project;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Gemini API ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text)
    .join("") || "";

  return text;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let model = null;
  const promptParts = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--model" || args[i] === "-m") && i + 1 < args.length) {
      model = args[++i];
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

  const result = await callGemini(prompt, model);
  process.stdout.write(result);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
