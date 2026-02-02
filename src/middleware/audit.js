// src/middleware/audit.js
import mongoose from "mongoose";
import { AuditLog } from "../models/AuditLog.js";
import { getRequestId } from "./error.js";

const SENSITIVE_KEY_RE = /password|token|secret|authorization|jwt|cookie|apiKey|api_key/i;

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

const ENTITY_MODELS = new Map([
  ["orders", "Order"],
  ["products", "Product"],
  ["coupons", "Coupon"],
  ["delivery-areas", "DeliveryArea"],
  ["pickup-points", "PickupPoint"],
  ["campaigns", "Campaign"],
  ["gifts", "Gift"],
  ["offers", "Offer"],
  ["users", "User"],
  ["categories", "Category"],
  ["content", "ContentPage"],
  ["approvals", "AdminApproval"],
]);

export function auditAdmin() {
  return async (req, res, next) => {
    const method = String(req.method || "").toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return next();
    }

    const entityType = pickEntityType(req);
    const entityId = req.params?.id ? String(req.params.id) : "";

    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && entityId && ENTITY_MODELS.has(entityType)) {
      try {
        const modelName = ENTITY_MODELS.get(entityType);
        const model = mongoose.connection?.models?.[modelName];
        if (model) {
          const doc = await model.findById(entityId).lean().exec();
          if (doc) res.locals.auditBefore = doc;
        }
      } catch (_) {
        // best-effort; continue without before
      }
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      res.locals.auditAfter = body?.data ?? body;
      if (body?.error?.code) res.locals.auditErrorCode = body.error.code;
      return originalJson(body);
    };

    res.once("finish", () => {
      void (async () => {
        const actorId = req.user?._id || null;
        const role = req.user?.role || "";
        const action = `${method} ${req.baseUrl || ""}${req.path || ""}`;

        const before = res.locals.auditBefore ?? null;
        let after = res.locals.auditAfter ?? null;

        if (!after && entityId && ENTITY_MODELS.has(entityType)) {
          try {
            const modelName = ENTITY_MODELS.get(entityType);
            const model = mongoose.connection?.models?.[modelName];
            if (model) {
              after = await model.findById(entityId).lean().exec();
            }
          } catch {
            // best-effort; ignore
          }
        }

        const rawBody = req.body && Object.keys(req.body).length ? req.body : null;
        const requestBody = rawBody ? sanitize(rawBody) : null;
        const statusCode = res.statusCode ?? null;
        const errorCode = res.locals.auditErrorCode ?? "";

        const payload = {
          actorId,
          role,
          action,
          entityType,
          entityId,
          before: sanitize(before),
          after: sanitize(after),
          requestBody,
          statusCode,
          errorCode: String(errorCode).slice(0, 64),
          requestId: getRequestId(req),
          ip: req.ip || "",
          userAgent: String(req.headers["user-agent"] || ""),
        };

        await AuditLog.create(payload);
      })().catch((e) => {
        console.warn("[best-effort] audit log create failed:", String(e?.message || e));
      });
    });

    return next();
  };
}
