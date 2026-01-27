// src/utils/maskPII.js

const SENSITIVE_KEY_RE = /phone|email|address|card|token|authorization/i;

function redactValue(value) {
  if (typeof value === "string" && value.length > 12) {
    return `${value.slice(0, 3)}***${value.slice(-3)}`;
  }
  return "[REDACTED]";
}

export function maskPII(input, depth = 0) {
  if (depth > 6) return "[Truncated]";
  if (input == null) return input;

  if (Array.isArray(input)) {
    return input.map((v) => maskPII(v, depth + 1));
  }

  if (typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = redactValue(v);
      } else {
        out[k] = maskPII(v, depth + 1);
      }
    }
    return out;
  }

  return input;
}
