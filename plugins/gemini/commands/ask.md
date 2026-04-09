---
description: Ask Gemini a question or request analysis without making any code changes
argument-hint: '[question or request]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Ask Gemini a question in read-only mode. Gemini will not make any file changes.

Raw slash-command arguments:
`$ARGUMENTS`

If the user did not provide a question, use `AskUserQuestion` to ask what they want to know.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-ask-direct.mjs" $ARGUMENTS
```

This uses a lightweight direct API call (no broker/daemon overhead).
Note: Do NOT add `--write`. This command is read-only by design.

Present only Gemini's response text to the user. Do not include job metadata, thread IDs, status codes, or JSON structure.
