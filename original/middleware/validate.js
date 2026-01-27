// src/middleware/validate.js
export function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
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
