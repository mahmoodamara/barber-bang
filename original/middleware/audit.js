// src/middleware/audit.js
import { AuditLog } from "../models/AuditLog.js";
import { getRequestId } from "./error.js";

const SENSITIVE_KEY_RE = /password|token|secret|authorization|jwt|cookie/i;

function sanitize(value, depth = 0) {
  if (depth > 5) return "[Truncated]";
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v, depth + 1));
  }

  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitize(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}

function pickEntityType(req) {
  const path = String(req.path || "").replace(/^\/+/, "");
  const parts = path.split("/").filter(Boolean);
  return parts[0] || "";
}

export function auditAdmin() {
  return (req, res, next) => {
    const method = String(req.method || "").toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return next();
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      res.locals.auditAfter = body?.data ?? body;
      return originalJson(body);
    };

    res.once("finish", () => {
      const actorId = req.user?._id || null;
      const role = req.user?.role || "";
      const action = `${method} ${req.baseUrl || ""}${req.path || ""}`;
      const entityType = pickEntityType(req);
      const entityId = req.params?.id ? String(req.params.id) : "";

      const before = res.locals.auditBefore ?? req.body ?? null;
      const after = res.locals.auditAfter ?? null;

      const payload = {
        actorId,
        role,
        action,
        entityType,
        entityId,
        before: sanitize(before),
        after: sanitize(after),
        requestId: getRequestId(req),
        ip: req.ip || "",
        userAgent: String(req.headers["user-agent"] || ""),
      };

      void AuditLog.create(payload).catch(() => {});
    });

    return next();
  };
}
