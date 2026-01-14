// src/controllers/adminFeatureFlags.controller.js
import { FeatureFlag } from "../models/index.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";

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

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

function normalizeKey(paramKey) {
  const key = String(paramKey || "").trim().toLowerCase();
  if (!key) throw httpError(400, "FEATURE_FLAG_KEY_REQUIRED", "key is required");
  return key;
}

function normalizeAllowUserIds(ids) {
  if (!Array.isArray(ids)) return undefined;
  // validators already enforce ObjectId strings; keep normalization here anyway
  return ids.map((x) => String(x).trim());
}

export async function listFeatureFlags(req, res) {
  const q = req.validated?.query || req.query || {};
  const page = Math.max(1, Number(q.page || 1));
  const limit = Math.min(200, Math.max(1, Number(q.limit || 50)));
  const skip = (page - 1) * limit;

  const filter = {};

  if (q.q) {
    const s = String(q.q).trim();
    filter.$or = [{ key: new RegExp(s, "i") }, { description: new RegExp(s, "i") }];
  }
  if (q.enabled === true) filter.enabled = true;
  if (q.enabled === false) filter.enabled = false;

  const [items, total] = await Promise.all([
    FeatureFlag.find(filter).sort({ updatedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    FeatureFlag.countDocuments(filter),
  ]);

  return res.json({
    ok: true,
    data: {
      items: items.map(toDTO),
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    },
  });
}

export async function upsertFeatureFlag(req, res) {
  const key = normalizeKey(req.params?.key);
  const body = req.validated?.body || {};

  // Safe patch (avoid mass assignment)
  const patch = pick(body, ["enabled", "rollout", "description", "rolesAllow", "allowUserIds"]);

  if (patch.allowUserIds !== undefined) patch.allowUserIds = normalizeAllowUserIds(patch.allowUserIds);

  // Do NOT trust updatedBy from client; set from auth
  const actorId = req.auth?.userId || null;
  patch.updatedBy = actorId;

  try {
    const doc = await FeatureFlag.findOneAndUpdate(
      { key },
      { $set: { ...patch, key }, $setOnInsert: { key } },
      { new: true, upsert: true },
    ).lean();

    await logAuditSuccess(req, AuditActions.ADMIN_FLAG_SET, {
      type: "FeatureFlag",
      id: key,
    }, { message: `Set feature flag: ${key} = ${patch.enabled}` });

    return res.json({ ok: true, data: { featureFlag: toDTO(doc) } });
  } catch (err) {
    if (err?.code === 11000) {
      await logAuditFail(req, AuditActions.ADMIN_FLAG_SET, {
        type: "FeatureFlag",
        id: key,
      }, { message: "Feature flag key already exists", code: "FEATURE_FLAG_KEY_EXISTS" });
      throw httpError(409, "FEATURE_FLAG_KEY_EXISTS", "Feature flag key already exists", { key });
    }
    await logAuditFail(req, AuditActions.ADMIN_FLAG_SET, { type: "FeatureFlag", id: key }, err);
    throw err;
  }
}

export async function deleteFeatureFlag(req, res) {
  const key = normalizeKey(req.params?.key);

  try {
    const doc = await FeatureFlag.findOne({ key });
    if (!doc) throw httpError(404, "FEATURE_FLAG_NOT_FOUND", "Feature flag not found", { key });

    // Soft-delete behavior: disable flag (keeps history & prevents breaking clients)
    doc.enabled = false;
    doc.updatedBy = req.auth?.userId || null;
    await doc.save();

    await logAuditSuccess(req, AuditActions.ADMIN_FLAG_DELETE, {
      type: "FeatureFlag",
      id: key,
    }, { message: `Deleted (disabled) feature flag: ${key}` });

    return res.json({ ok: true, data: { featureFlag: toDTO(doc) } });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_FLAG_DELETE, { type: "FeatureFlag", id: key }, err);
    throw err;
  }
}
