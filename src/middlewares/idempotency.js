export function idempotency(req, _res, next) {
  const key = req.headers["idempotency-key"] ?? req.headers["x-idempotency-key"];
  if (typeof key === "string" && key.trim()) req.idempotencyKey = key.trim();
  next();
}
