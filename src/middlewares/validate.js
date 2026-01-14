function unwrapNestedBody(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const keys = Object.keys(payload);
  if (keys.length === 1 && keys[0] === "body" && payload.body && typeof payload.body === "object") {
    return payload.body;
  }
  return payload;
}

export function validate(zodSchema) {
  return (req, _res, next) => {
    // Support both validation styles:
    // 1) wrapped: schema expects { body, query, params, headers }
    // 2) body-only: schema expects the request body shape
    const wrapped = {
      body: req.body,
      query: req.query,
      params: req.params,
      headers: req.headers,
    };

    const r1 = zodSchema.safeParse(wrapped);
    if (r1.success) {
      req.validated = r1.data;
      return next();
    }

    const r2 = zodSchema.safeParse(req.body);
    if (r2.success) {
      req.validated = {
        body: unwrapNestedBody(r2.data),
        query: req.query,
        params: req.params,
        headers: req.headers,
      };
      return next();
    }

    return next(r1.error);
  };
}
