// src/services/invoice/httpClient.js
// Timeout + retry helper for invoice provider HTTP calls. No API keys or PII in logs.

const DEFAULT_TIMEOUT_MS = Number(process.env.INVOICE_HTTP_TIMEOUT_MS) || 10000;
const DEFAULT_RETRIES = Number(process.env.INVOICE_HTTP_RETRIES) || 2;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 1500;

/**
 * True if HTTP status is retryable (429 or 5xx).
 */
export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * fetch with timeout. Rejects with error.name === "AbortError" on timeout.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return res;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

/**
 * Retry fn with exponential backoff. Only retries when fn throws (transient:
 * network errors, timeouts, or provider throws for 429/5xx). Do NOT retry on 4xx (except 429).
 */
export async function retryWithBackoff(fn, opts = {}) {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? MAX_DELAY_MS;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) {
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_RETRIES };
