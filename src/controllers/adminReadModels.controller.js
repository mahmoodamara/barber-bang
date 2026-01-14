// src/controllers/adminReadModels.controller.js
import { ReadModel } from "../models/index.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function toDTO(docOrLean) {
  if (!docOrLean) return docOrLean;
  const d = typeof docOrLean.toObject === "function" ? docOrLean.toObject() : docOrLean;
  const { _id, ...rest } = d;
  return { ...rest, id: String(_id) };
}

/**
 * Admin Read Models Controller
 * Must match admin.readModels.routes.js exports:
 * - listReadModels
 * - getReadModel
 *
 * Contract:
 * - Routes are /read-models/:key
 * - :key is a canonical read-model key (NOT an ObjectId)
 *   (validator enforces this; controller assumes it)
 */

export async function listReadModels(req, res) {
  const q = req.validated?.query || req.query || {};
  const page = Math.max(1, Number(q.page || 1));
  const limit = Math.min(200, Math.max(1, Number(q.limit || 50)));
  const skip = (page - 1) * limit;

  const filter = {};
  if (q.type) filter.type = String(q.type).trim();
  if (q.key) filter.key = String(q.key).trim();

  const [items, total] = await Promise.all([
    ReadModel.find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ReadModel.countDocuments(filter),
  ]);

  return res.json({
    ok: true,
    data: {
      items: items.map(toDTO),
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    },
  });
}

export async function getReadModel(req, res) {
  const key = String(req.params?.key || "").trim();
  if (!key) throw httpError(400, "INVALID_READ_MODEL_KEY", "Missing key");

  const doc = await ReadModel.findOne({ key }).lean();
  if (!doc) throw httpError(404, "READ_MODEL_NOT_FOUND", "Read model not found", { key });

  return res.json({ ok: true, data: { readModel: toDTO(doc) } });
}

/**
 * Optional endpoint (not wired in routes by default)
 * If you add POST /read-models/:key/rebuild, keep it admin-only + idempotency required.
 */
export async function rebuildReadModel(req, res) {
  const key = String(req.params?.key || "").trim();
  if (!key) throw httpError(400, "INVALID_READ_MODEL_KEY", "Missing key");

  const updated = await ReadModel.findOneAndUpdate(
    { key },
    { $set: { rebuildRequestedAt: new Date() } },
    { new: true },
  ).lean();

  if (!updated) throw httpError(404, "READ_MODEL_NOT_FOUND", "Read model not found", { key });

  return res.json({ ok: true, data: { readModel: toDTO(updated), accepted: true } });
}
