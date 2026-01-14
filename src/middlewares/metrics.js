import { httpRequestDurationMs, httpRequestsTotal, httpErrorsTotal } from "../observability/prom.js";

function normalizePath(p) {
  return String(p || "/")
    .split("?")[0]
    .replace(/\/\d+(?=\/|$)/g, "/:n")
    .replace(/\/[0-9a-fA-F]{8,}(?=\/|$)/g, "/:id");
}

function routeLabel(req) {
  const base = req.baseUrl || "";
  const rp = req.route?.path;

  if (rp) return normalizePath(`${base}${rp}`);
  return normalizePath(req.originalUrl || req.path || "/");
}

export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;

    const route = routeLabel(req);
    const status = String(res.statusCode);
    const method = req.method;

    httpRequestDurationMs.labels(method, route, status).observe(ms);
    httpRequestsTotal.labels(method, route, status).inc();
    if (res.statusCode >= 500) httpErrorsTotal.labels(method, route, status).inc();
  });

  next();
}
