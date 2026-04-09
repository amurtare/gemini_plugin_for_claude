---
description: Run a Gemini task directly without subagent routing (faster than /gemini:rescue)
argument-hint: "[--background|--wait] [--resume-last|--fresh] [--model <pro|flash|pro-3|flash-3>] [prompt]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Gemini task directly through the companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command executes the task directly. It does not route through a subagent.
- For subagent-assisted prompt refinement, use `/gemini:rescue` instead.

If the user did not provide a prompt, use `AskUserQuestion` to ask what Gemini should do.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- If neither flag is present, default to foreground.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task --write "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task --write --background "$ARGUMENTS"`,
  description: "Gemini task",
  run_in_background: true
})
```
- After launching, tell the user: "Gemini task started in the background. Check `/gemini:status` for progress."

Model shortcuts: `flash` = gemini-2.5-flash, `pro` = gemini-2.5-pro, `flash-3` = gemini-2.5-flash-preview-04-17, `pro-3` = gemini-2.5-pro-preview-03-25
