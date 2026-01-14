// src/middlewares/idempotencyEnforce.js
import {
  makeIdempotencyKey,
  makeRequestHash,
  beginIdempotency,
  completeIdempotency,
  failIdempotency,
} from "../services/idempotencyStore.service.js";

/**
 * Idempotency middleware — Hardened (Admin-grade)
 *
 * Guarantees:
 * - Never responds with raw { error: ... } directly; always next(err) except when replaying stored response.
 * - Hashes a stable body (prefers req.validated.body) to prevent conflicts from raw/unvalidated payload differences.
 * - Stores "done" only for responses with statusCode < 500.
 * - Stores "failed" for statusCode >= 500 and for client aborts (499).
 * - Replays stored response for "done" (and optionally for "failed" if stored).
 * - Adds X-Idempotency-Replayed header on replay.
 * - Adds Retry-After header on "processing" and certain "failed" scenarios to guide clients.
 *
 * Notes:
 * - Requires requireAuth earlier if you want per-user isolation (userId included in key).
 * - Key reuse with different requestHash => 409 conflict.
 * - "processing" => 409 in progress (client should retry later with SAME key).
 * - "failed" => retry with SAME key (safe), unless you intentionally want clients to rotate keys.
 */

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function resolveRoute(req, routeName) {
  return (
    routeName ||
    req.originalUrl ||
    (req.baseUrl && req.path ? req.baseUrl + req.path : "") ||
    req.path ||
    "unknown_route"
  );
}

function getStableBody(req) {
  const b = req?.validated?.body;
  if (b && typeof b === "object") return b;

  if (req.body && typeof req.body === "object") return req.body;

  return null;
}

function getIdempotencyKeyFromReq(req) {
  const raw =
    req?.headers?.["idempotency-key"] ??
    req?.headers?.["x-idempotency-key"] ??
    req?.headers?.["X-Idempotency-Key"];
  return typeof raw === "string" ? raw.trim() : String(raw || "").trim();
}

function shouldStoreAsFailed(statusCode) {
  const sc = Number(statusCode || 200);
  return sc >= 500 || sc === 499;
}

function normalizeReplayBody(record) {
  // Ensure we always replay something valid
  if (record?.responseBody !== undefined && record?.responseBody !== null) return record.responseBody;
  if (Number(record?.responseStatus || 200) >= 400) {
    return { ok: false, error: { code: "REPLAYED_ERROR", message: "Replayed error" } };
  }
  return { ok: true, data: null };
}

export function idempotencyEnforce({ routeName, required = false } = {}) {
  return async (req, res, next) => {
    try {
      const rawKey = getIdempotencyKeyFromReq(req);

      if (!rawKey) {
        if (required) {
          return next(
            httpError(
              400,
              "IDEMPOTENCY_KEY_REQUIRED",
              "Idempotency-Key (or X-Idempotency-Key) header is required for this endpoint",
            ),
          );
        }
        return next();
      }

      const route = resolveRoute(req, routeName);
      const userId = req.auth?.userId || null;

      const key = makeIdempotencyKey({ route, userId, rawKey });
      const stableBody = getStableBody(req);

      const requestHash = makeRequestHash({
        method: req.method,
        route,
        body: stableBody,
      });

      const { record } = await beginIdempotency({
        key,
        userId,
        route,
        method: req.method,
        requestHash,
      });

      if (record) {
        // Same key but different request signature => conflict
        if (record.requestHash !== requestHash) {
          return next(
            httpError(
              409,
              "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY",
              "Idempotency key was reused with a different request body",
              { route },
            ),
          );
        }

        if (record.status === "processing") {
          // Encourage retry with SAME key
          res.setHeader("Retry-After", "2");
          return next(
            httpError(
              409,
              "IDEMPOTENCY_IN_PROGRESS",
              "This request is already being processed",
              { route },
            ),
          );
        }

        if (record.status === "done") {
          // Replay the stored response
          res.setHeader("X-Idempotency-Replayed", "1");
          res.setHeader("Cache-Control", "no-store");
          return res
            .status(Number(record.responseStatus || 200))
            .json(normalizeReplayBody(record));
        }

        if (record.status === "failed") {
          // Prefer replay if we stored a failure response; otherwise instruct retry with SAME key.
          if (record.responseBody !== undefined) {
            res.setHeader("X-Idempotency-Replayed", "1");
            res.setHeader("Cache-Control", "no-store");
            return res
              .status(Number(record.responseStatus || 409))
              .json(normalizeReplayBody(record));
          }

          res.setHeader("Retry-After", "2");
          return next(
            httpError(
              409,
              "IDEMPOTENCY_PREVIOUSLY_FAILED",
              "Previous attempt failed; retry with the SAME idempotency key",
              { route },
            ),
          );
        }
      }

      // Capture response exactly once
      const origJson = res.json.bind(res);
      const origSend = res.send.bind(res);
      let stored = false;

      const storeDone = async (body) => {
        if (stored) return;
        stored = true;
        await completeIdempotency({
          key,
          responseStatus: res.statusCode,
          responseBody: body,
        });
      };

      const storeFailed = async (status, body) => {
        if (stored) return;
        stored = true;
        await failIdempotency({
          key,
          responseStatus: status,
          responseBody: body,
        });
      };

      res.json = (body) => {
        const sc = Number(res.statusCode || 200);
        (shouldStoreAsFailed(sc) ? storeFailed(sc, body) : storeDone(body)).catch(() => {});
        return origJson(body);
      };

      res.send = (body) => {
        const sc = Number(res.statusCode || 200);

        const safeBody =
          typeof body === "string" || Buffer.isBuffer(body)
            ? sc >= 400
              ? { ok: false, error: { code: "NON_JSON_ERROR", message: "Non-JSON response" } }
              : { ok: true, data: null }
            : body;

        (shouldStoreAsFailed(sc) ? storeFailed(sc, safeBody) : storeDone(safeBody)).catch(() => {});
        return origSend(body);
      };

      // If client aborts early, persist a "failed" marker (499)
      res.on("close", () => {
        if (!res.writableEnded) {
          storeFailed(499, {
            ok: false,
            error: { code: "CLIENT_ABORT", message: "Client aborted request" },
          }).catch(() => {});
        }
      });

      return next();
    } catch (_e) {
      // Route through centralized error handler
      return next(
        httpError(
          500,
          "IDEMPOTENCY_INTERNAL_ERROR",
          "Idempotency middleware failed",
        ),
      );
    }
  };
}
