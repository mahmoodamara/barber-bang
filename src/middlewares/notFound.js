function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

export function notFound(req, res, next) {
  if (req.originalUrl?.startsWith("/api/v1")) {
    return next(httpError(404, "NOT_FOUND", "Route not found"));
  }

  return res.status(404).send("Not Found");
}
