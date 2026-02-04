// src/middleware/validate.js

export function validate(schema) {
  return (req, _res, next) => {
    // ✅ Prevent strict Zod query schemas from breaking when UI sends ?lang=he|ar
    // We treat lang/locale as UI-only transport params (handled elsewhere), not part of business validation.
    const cleanQuery = { ...(req.query || {}) };
    delete cleanQuery.lang;
    delete cleanQuery.locale;

    const payload = { body: req.body, params: req.params };
    if (req.method === "GET") payload.query = cleanQuery;

    const result = schema.safeParse(payload);

    if (!result.success) {
      // ✅ forward ZodError to central errorHandler
      // so we always get:
      // { ok:false, error:{ code,message,requestId,path,details } }
      return next(result.error);
    }

    req.validated = result.data;
    return next();
  };
}
