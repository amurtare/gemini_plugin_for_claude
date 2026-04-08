---
name: gemini-prompting
description: How to compose effective prompts for Gemini when forwarding tasks through the companion runtime
user-invocable: false
---

This skill teaches how to compose effective prompts for Gemini CLI when forwarding rescue tasks.

## Core principles

1. **Be specific**: Tell Gemini exactly what to investigate or fix. Include file names, function names, and error messages when available.
2. **Set clear boundaries**: Specify what Gemini should and should not change.
3. **Define success**: Describe what a good outcome looks like.
4. **Include context**: Mention relevant background that Gemini needs to understand the problem.

## Prompt structure

Use this structure for forwarded prompts:

```
<task>
[What to do — one clear sentence]
</task>

<context>
[Relevant background: error messages, file paths, constraints]
</context>

<scope>
[What files/areas to focus on, what to leave alone]
</scope>

<verification>
[How to verify the fix works — tests to run, behavior to check]
</verification>
```

## Anti-patterns

- **Too vague**: "Fix the bug" → Better: "Fix the TypeError in src/auth.js:42 where user.email is undefined when OAuth callback has no profile"
- **Too broad**: "Refactor everything" → Better: "Extract the validation logic from handleSubmit into a separate validateForm function"
- **No verification**: Always include how to test the change

## Model selection guidance

- Use `gemini-2.5-pro` (default) for complex multi-file changes, architectural decisions, and deep debugging
- Use `gemini-2.5-flash` for simple fixes, quick investigations, and cost-sensitive tasks
