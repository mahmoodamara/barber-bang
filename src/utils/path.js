// src/utils/path.js

/**
 * Normalize URL to a canonical path for logging and metrics.
 * Strips query string and normalizes trailing slashes (keeps root "/").
 * Library-agnostic; safe to use in middleware and error handler.
 *
 * @param {string} originalUrl - Full request URL (e.g. req.originalUrl)
 * @returns {string} Path only, no query, no trailing slash (except "/")
 */
export function normalizePath(originalUrl) {
  const url = String(originalUrl ?? "");
  const pathOnly = url.split("?")[0];
  if (pathOnly.length > 1 && pathOnly.endsWith("/")) {
    return pathOnly.slice(0, -1);
  }
  return pathOnly || "/";
}
