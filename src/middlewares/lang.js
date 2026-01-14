const SUPPORTED_LANGS = new Set(["he", "ar"]);

function parseAcceptLanguage(header) {
  if (typeof header !== "string") return null;
  const parts = header.toLowerCase().split(",");
  for (const part of parts) {
    const tag = part.trim().split(";")[0];
    if (!tag) continue;
    if (tag === "he" || tag.startsWith("he-")) return "he";
    if (tag === "ar" || tag.startsWith("ar-")) return "ar";
  }
  return null;
}

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

export function langMiddleware(req, res, next) {
  const q = req.query?.lang;
  if (q !== undefined) {
    if (typeof q === "string" && SUPPORTED_LANGS.has(q)) {
      req.lang = q;
    } else {
      return next(
        httpError(400, "INVALID_LANG", "Invalid lang", [{ path: "query.lang", value: q }]),
      );
    }
  } else {
    const headerLang = parseAcceptLanguage(req.headers["accept-language"]);
    req.lang = headerLang || "he";
  }

  if (!res.getHeader("content-language")) {
    res.setHeader("content-language", req.lang);
  }

  return next();
}

export default langMiddleware;
