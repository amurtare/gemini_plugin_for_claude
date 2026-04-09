# Agent Plugin for Claude Code

Use **Codex** and **Gemini CLI** from inside Claude Code for code reviews, task delegation, and Q&A.

This is a multi-agent plugin marketplace. Claude Code users can install either or both plugins to delegate work to OpenAI Codex or Google Gemini from within their existing workflow.

## Plugins

| Plugin | Description | Provider |
|--------|-------------|----------|
| **codex** | Code review & task delegation via OpenAI Codex | OpenAI |
| **gemini** | Code review, task delegation & Q&A via Google Gemini CLI | Community |

---

## Gemini Plugin

### What You Get

- `/gemini:ask` to ask Gemini a question (read-only)
- `/gemini:review` for a Gemini code review
- `/gemini:adversarial-review` for a steerable challenge review
- `/gemini:rescue`, `/gemini:status`, `/gemini:result`, and `/gemini:cancel` to delegate work and manage background jobs

### Requirements

- **Google Gemini CLI** installed (`npm install -g @google/gemini-cli`)
- **Authentication** — one of:
  - Google OAuth (run `gemini` for browser-based login)
  - `GEMINI_API_KEY` environment variable
  - `GOOGLE_API_KEY` + Vertex AI configuration
- **Node.js 18.18 or later**

### Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add amurtare/agent_plugin
```

Install the plugin:

```bash
/plugin install gemini@agent-plugin
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/gemini:setup
```

`/gemini:setup` will tell you whether Gemini CLI is ready and authenticated.

If you prefer to install Gemini CLI yourself:

```bash
npm install -g @google/gemini-cli
```

After install, you should see:

- the slash commands listed below
- the `gemini:gemini-rescue` subagent in `/agents`

One simple first run is:

```bash
/gemini:ask explain the architecture of this project
```

### Usage

#### `/gemini:ask`

Ask Gemini a question in read-only mode. Gemini will not make any file changes.

Examples:

```bash
/gemini:ask explain the architecture of this project
/gemini:ask what does the handleAuth function do?
/gemini:ask compare React and Vue for this use case
```

#### `/gemini:review`

Runs a Gemini review on your current work.

> **Note:** Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`.

Examples:

```bash
/gemini:review
/gemini:review --base main
/gemini:review --background
```

This command is read-only and will not perform any changes.

#### `/gemini:adversarial-review`

Runs a **steerable** review that challenges the chosen implementation and design.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/gemini:adversarial-review
/gemini:adversarial-review --base main challenge whether this was the right caching design
/gemini:adversarial-review --background look for race conditions
```

This command is read-only. It does not fix code.

#### `/gemini:rescue`

Hands a task to Gemini through the `gemini:gemini-rescue` subagent.

Use it when you want Gemini to:

- investigate a bug
- try a fix
- continue a previous Gemini task

It supports `--background`, `--wait`, `--resume`, and `--fresh`.

Examples:

```bash
/gemini:rescue investigate why the tests started failing
/gemini:rescue fix the failing test with the smallest safe patch
/gemini:rescue --resume apply the top fix from the last run
/gemini:rescue --model gemini-2.5-flash investigate the flaky test
/gemini:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Gemini:

```text
Ask Gemini to redesign the database connection to be more resilient.
```

**Notes:**

- Model aliases: `flash` maps to `gemini-2.5-flash`, `pro` maps to `gemini-2.5-pro`
- Follow-up rescue requests can continue the latest Gemini task in the repo

#### `/gemini:status`

Shows running and recent Gemini jobs for the current repository.

```bash
/gemini:status
/gemini:status task-abc123
```

#### `/gemini:result`

Shows the final stored Gemini output for a finished job.

```bash
/gemini:result
/gemini:result task-abc123
```

#### `/gemini:cancel`

Cancels an active background Gemini job.

```bash
/gemini:cancel
/gemini:cancel task-abc123
```

#### `/gemini:setup`

Checks whether Gemini CLI is installed and authenticated. Supports the optional review gate:

```bash
/gemini:setup --enable-review-gate
/gemini:setup --disable-review-gate
```

> **Warning:** The review gate can create a long-running Claude/Gemini loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

### Gemini Integration

The Gemini plugin wraps the [Gemini CLI](https://github.com/google-gemini/gemini-cli) through a custom App Server that manages threads and streams results via JSON-RPC.

Unlike Codex which has a built-in app server daemon, the Gemini plugin runs its own server that:

- Spawns `gemini -p` with `--output-format stream-json` for each turn
- Manages conversation history across turns (with context summarization for long sessions)
- Translates Gemini's streaming JSONL events into the JSON-RPC notification protocol

### Authentication Methods

| Method | Setup |
|--------|-------|
| Google OAuth (free tier) | Run `gemini` and sign in via browser |
| API Key | `export GEMINI_API_KEY="your-key"` |
| Vertex AI (enterprise) | `export GOOGLE_API_KEY="your-key"` + `GOOGLE_GENAI_USE_VERTEXAI=true` |

---

## Codex Plugin

### What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work and manage background jobs

### Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

### Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add amurtare/agent_plugin
```

Install the plugin:

```bash
/plugin install codex@agent-plugin
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

If Codex is missing and npm is available, it can offer to install Codex for you:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in:

```bash
!codex login
```

### Usage

#### `/codex:review`

Runs a normal Codex review on your current work.

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

#### `/codex:adversarial-review`

Runs a steerable review that challenges the implementation.

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching design
```

#### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

#### `/codex:status`, `/codex:result`, `/codex:cancel`

Manage background Codex jobs.

```bash
/codex:status
/codex:result
/codex:cancel task-abc123
```

#### `/codex:setup`

Checks whether Codex is installed and authenticated.

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

### Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

---

## Typical Flows

### Ask Gemini a Question

```bash
/gemini:ask what is the best way to handle auth in this codebase?
```

### Review Before Shipping

```bash
/gemini:review
/codex:review
```

### Hand A Problem To An Agent

```bash
/gemini:rescue investigate why the build is failing in CI
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/gemini:adversarial-review --background
/gemini:rescue --background investigate the flaky test
```

Then check in with:

```bash
/gemini:status
/gemini:result
```

---

## FAQ

### Can I use both plugins at the same time?

Yes. Codex and Gemini plugins are independent. Install both and use whichever fits the task.

### Do I need separate accounts?

- **Codex**: Uses your local Codex CLI authentication (ChatGPT account or API key)
- **Gemini**: Uses your local Gemini CLI authentication (Google OAuth or API key)

### Does the Gemini plugin use a daemon like Codex?

Codex has a built-in `codex app-server` daemon. The Gemini plugin includes its own lightweight App Server that wraps `gemini -p` CLI calls behind the same JSON-RPC protocol. It is started automatically when needed and cleaned up on session end.

## License

Apache-2.0
