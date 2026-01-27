// src/middleware/validate.js

export function validate(schema) {
  return (req, _res, next) => {
    // ✅ Prevent strict Zod query schemas from breaking when UI sends ?lang=he|ar
    // We treat lang/locale as UI-only transport params (handled elsewhere), not part of business validation.
    const cleanQuery = { ...(req.query || {}) };
    delete cleanQuery.lang;
    delete cleanQuery.locale;

    const result = schema.safeParse({
      body: req.body,
      query: cleanQuery,
      params: req.params,
    });

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
