---
name: gemini-result-handling
description: Internal guidance for presenting Gemini output back to the user
user-invocable: false
---

This skill defines how to present Gemini companion output to the user.

## Review output

Gemini review results follow this structure:
- **Verdict**: `approve` or `needs-attention`
- **Summary**: A terse assessment of the changes
- **Findings**: Specific issues with file, line range, severity, and recommendation
- **Next steps**: Actionable follow-up items

Present the output verbatim. Do not reformat, summarize, or add commentary.

## Task output

Gemini task results include:
- The raw output from Gemini's response
- File changes made (if `--write` was used)
- Reasoning summary (if available)

Present the output verbatim. If there were file changes, the user can review them with `git diff`.

## Error output

If a Gemini run fails, the output includes an error message and stderr. Present both to help the user diagnose the issue.

## Follow-up commands

After presenting results, remind the user of available follow-up commands:
- `/gemini:status` — Check running jobs
- `/gemini:result <job-id>` — View past results
- `/gemini:cancel <job-id>` — Cancel running jobs
