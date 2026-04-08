---
name: gemini-cli-runtime
description: Internal contract for calling gemini-companion.mjs from the gemini:gemini-rescue subagent
user-invocable: false
---

This skill defines how the `gemini:gemini-rescue` subagent invokes the Gemini companion runtime.

## Command format

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task [flags] [prompt]
```

## Flags

- `--write` — Allow Gemini to make file changes (default for rescue tasks).
- `--resume-last` — Continue the most recent Gemini task thread.
- `--fresh` — Force a new thread even if a resumable thread exists.
- `--model <name>` — Override the model. Common values: `gemini-2.5-pro`, `gemini-2.5-flash`.
- `--background` — Queue the task for background execution.
- `--json` — Return structured JSON output.

## Model aliases

| Alias | Model |
|-------|-------|
| `flash` | `gemini-2.5-flash` |
| `pro` | `gemini-2.5-pro` |

## Output

The command prints its result to stdout. The subagent must return this output verbatim without modification.

## Error handling

If the command exits with a non-zero code, the subagent should return nothing. Common errors:
- Gemini CLI not installed → tell the user to run `/gemini:setup`
- Not authenticated → tell the user to set `GEMINI_API_KEY` or run `gemini` to sign in
