// src/middleware/lang.js
// Determines request language (default: Hebrew)
// Priority:
//  (1) ?lang=he|ar
//  (2) Accept-Language header (FIRST token only; must start with "he" or "ar")
//  (3) default "he"

const SUPPORTED = new Set(["he", "ar"]);

function normalizeLang(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return null;

  // Direct "he" | "ar"
  if (SUPPORTED.has(v)) return v;

  // Accept-Language example:
  // "he-IL,he;q=0.9,en;q=0.8"
  // Rule: ONLY the first token is considered.
  const firstToken = v.split(",")[0]?.trim();
  if (!firstToken) return null;

  // Rule: token must START WITH "he" or "ar"
  // so "he-IL" -> "he", "ar-EG" -> "ar"
  if (firstToken.startsWith("he")) return "he";
  if (firstToken.startsWith("ar")) return "ar";

  return null;
}

export function langMiddleware(req, _res, next) {
  const fromQuery = normalizeLang(req.query?.lang);
  const fromHeader = normalizeLang(req.headers?.["accept-language"]);

  req.lang = fromQuery || fromHeader || "he";
  next();
}
