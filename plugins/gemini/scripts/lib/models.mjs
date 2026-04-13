/**
 * Centralized model management for the Gemini plugin.
 *
 * All model aliases, defaults, and resolution logic in one place.
 * When Gemini releases new models, only this file needs updating.
 */

/** Default model for general use */
export const DEFAULT_MODEL = "gemini-2.5-flash";

/** Default model for review tasks */
export const DEFAULT_REVIEW_MODEL = "gemini-2.5-pro";

/** Model alias map — short names to full model IDs */
export const MODEL_ALIASES = new Map([
  ["flash", "gemini-2.5-flash"],
  ["pro", "gemini-2.5-pro"],
  ["flash-3", "gemini-2.5-flash-preview-04-17"],
  ["pro-3", "gemini-2.5-pro-preview-03-25"]
]);

/** All known valid model prefixes */
const VALID_MODEL_PREFIXES = ["gemini-"];

/**
 * Resolve a user-provided model string to a full model ID.
 * - Alias ("flash") → full ID ("gemini-2.5-flash")
 * - Full ID ("gemini-2.5-pro") → passed through
 * - null/undefined → null (caller decides default)
 *
 * @param {string | null | undefined} input
 * @returns {string | null}
 */
export function resolveModel(input) {
  if (input == null) return null;
  const normalized = String(input).trim().toLowerCase();
  if (!normalized) return null;
  return MODEL_ALIASES.get(normalized) ?? input.trim();
}

/**
 * Validate that a resolved model looks like a valid Gemini model ID.
 * Does not check if the model actually exists — just format validation.
 *
 * @param {string} model
 * @returns {{ valid: boolean, message?: string }}
 */
export function validateModel(model) {
  if (!model || typeof model !== "string") {
    return { valid: false, message: "Model name is required." };
  }
  const isAlias = MODEL_ALIASES.has(model.toLowerCase());
  const isFullId = VALID_MODEL_PREFIXES.some((p) => model.startsWith(p));
  if (!isAlias && !isFullId) {
    const aliases = [...MODEL_ALIASES.keys()].join(", ");
    return {
      valid: false,
      message: `Unknown model "${model}". Use a full model ID (gemini-*) or an alias: ${aliases}`
    };
  }
  return { valid: true };
}

/**
 * Get a display-friendly list of available model aliases for help text.
 * @returns {string}
 */
export function formatModelHelp() {
  const lines = [];
  for (const [alias, fullId] of MODEL_ALIASES) {
    lines.push(`  ${alias} → ${fullId}`);
  }
  return lines.join("\n");
}
