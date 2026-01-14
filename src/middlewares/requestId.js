import crypto from "crypto";

export function requestId(req, res, next) {
  const header = req.headers["x-request-id"];
  const id = typeof header === "string" && header.trim() ? header.trim() : crypto.randomUUID();

  req.requestId = id;
  res.setHeader("x-request-id", id);

  next();
}
