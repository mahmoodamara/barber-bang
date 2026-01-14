import crypto from "node:crypto";
import { IdempotencyRecord } from "../models/IdempotencyRecord.js";
import { ENV } from "../utils/env.js";

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeBody(body) {
  try {
    return JSON.stringify(body ?? {});
  } catch {
    return String(body ?? "");
  }
}

function ttlHours() {
  return Math.max(1, Number(ENV.IDEMPOTENCY_TTL_HOURS || 24));
}

function maxBodyBytes() {
  return Math.max(1000, Number(ENV.IDEMPOTENCY_MAX_BODY_BYTES || 60000));
}

// Do NOT leak raw idempotency keys. Hash with route + user.
export function makeIdempotencyKey({ route, userId, rawKey }) {
  const uid = userId ? String(userId) : "anon";
  return sha256(`${route}:${uid}:${rawKey}`);
}

export function makeRequestHash({ method, route, body }) {
  return sha256(`${method}:${route}:${normalizeBody(body)}`);
}

export async function beginIdempotency({ key, userId, route, method, requestHash }) {
  const expiresAt = new Date(Date.now() + ttlHours() * 60 * 60_000);

  // Atomic upsert to avoid race duplicates across instances
  try {
    const doc = await IdempotencyRecord.findOneAndUpdate(
      { key },
      {
        $setOnInsert: {
          key,
          userId: userId || null,
          route,
          method,
          requestHash,
          status: "processing",
          expiresAt,
        },
        $set: { expiresAt },
      },
      { new: true, upsert: true },
    ).lean();

    // If existed, doc may contain done/failed/processing; treat as existing unless it’s a fresh "processing" created now.
    // We cannot perfectly detect insert vs existing without extra fields; the middleware below handles by status/hash.
    return { record: doc };
  } catch {
    const doc = await IdempotencyRecord.findOne({ key }).lean();
    return { record: doc };
  }
}

export async function completeIdempotency({ key, responseStatus, responseBody }) {
  let body = responseBody;

  try {
    const json = JSON.stringify(responseBody ?? {});
    if (Buffer.byteLength(json, "utf8") > maxBodyBytes()) {
      body = { ok: false, error: { code: "IDEMPOTENCY_RESPONSE_TOO_LARGE" } };
    }
  } catch {
    body = { ok: false, error: { code: "IDEMPOTENCY_RESPONSE_SERIALIZE_FAILED" } };
  }

  await IdempotencyRecord.updateOne(
    { key },
    { $set: { status: "done", responseStatus, responseBody: body } },
  );
}

export async function failIdempotency({ key, responseStatus = 500, responseBody }) {
  await IdempotencyRecord.updateOne(
    { key },
    { $set: { status: "failed", responseStatus, responseBody } },
  );
}
