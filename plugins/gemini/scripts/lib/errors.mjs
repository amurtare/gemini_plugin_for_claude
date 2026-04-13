/**
 * Structured error handling for the Gemini plugin.
 *
 * Classifies errors by type and provides user-friendly messages
 * with actionable suggestions.
 */

/**
 * Error types and their metadata.
 */
const ERROR_TYPES = {
  auth_failed: {
    label: "Authentication Failed",
    suggestion: "Run /gemini:setup to check authentication status."
  },
  auth_expired: {
    label: "Authentication Expired",
    suggestion: "Re-authenticate: run `gemini` in terminal, or refresh GEMINI_API_KEY."
  },
  connection_failed: {
    label: "Connection Failed",
    suggestion: "Check your network connection and try again."
  },
  cli_not_found: {
    label: "Gemini CLI Not Found",
    suggestion: "Install with `npm install -g @google/gemini-cli`, then run /gemini:setup."
  },
  acp_timeout: {
    label: "ACP Initialization Timeout",
    suggestion: "Gemini CLI may be updating. Try again in a moment."
  },
  rate_limited: {
    label: "Rate Limited",
    suggestion: "Request limit exceeded. Wait a moment and try again."
  },
  model_not_found: {
    label: "Model Not Available",
    suggestion: "Check available models with /gemini:setup. Use --model flash or --model pro."
  },
  permission_denied: {
    label: "Permission Denied",
    suggestion: "Check GOOGLE_CLOUD_PROJECT is set correctly for your enterprise account."
  },
  server_error: {
    label: "Server Error",
    suggestion: "Gemini API is experiencing issues. Try again shortly."
  },
  unknown: {
    label: "Unexpected Error",
    suggestion: "Run /gemini:setup to diagnose. If the issue persists, check Gemini CLI status."
  }
};

/**
 * Classify an error message into a structured error type.
 *
 * @param {string | Error} error
 * @returns {{ type: string, label: string, message: string, suggestion: string }}
 */
export function classifyError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  const lower = message.toLowerCase();

  let type = "unknown";

  if (lower.includes("enoent") && lower.includes("gemini")) {
    type = "cli_not_found";
  } else if (lower.includes("authentication") || lower.includes("unauthenticated") || lower.includes("login")) {
    type = "auth_failed";
  } else if (lower.includes("token") && (lower.includes("expired") || lower.includes("invalid"))) {
    type = "auth_expired";
  } else if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("connection")) {
    type = "connection_failed";
  } else if (lower.includes("timeout") || lower.includes("timed out")) {
    type = "acp_timeout";
  } else if (lower.includes("rate") || lower.includes("429") || lower.includes("quota") || lower.includes("resource_exhausted")) {
    type = "rate_limited";
  } else if (lower.includes("model") && (lower.includes("not found") || lower.includes("not available"))) {
    type = "model_not_found";
  } else if (lower.includes("permission") || lower.includes("403") || lower.includes("forbidden") || lower.includes("scope_insufficient")) {
    type = "permission_denied";
  } else if (lower.includes("500") || lower.includes("502") || lower.includes("503") || lower.includes("internal")) {
    type = "server_error";
  }

  const meta = ERROR_TYPES[type];
  return {
    type,
    label: meta.label,
    message: message || "An unknown error occurred.",
    suggestion: meta.suggestion
  };
}

/**
 * Format a structured error for display.
 *
 * @param {{ type: string, label: string, message: string, suggestion: string }} err
 * @returns {string}
 */
export function formatError(err) {
  return `[${err.label}] ${err.message}\n→ ${err.suggestion}`;
}

/**
 * Format a structured error as JSON.
 *
 * @param {{ type: string, label: string, message: string, suggestion: string }} err
 * @returns {object}
 */
export function formatErrorJson(err) {
  return {
    error: {
      type: err.type,
      label: err.label,
      message: err.message,
      suggestion: err.suggestion
    }
  };
}
