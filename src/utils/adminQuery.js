import mongoose from "mongoose";

import { parsePagination as parsePaginationUtil } from "./paginate.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

export function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

export function requireObjectId(id, code = "INVALID_ID") {
  const v = String(id || "");
  if (!isValidObjectId(v)) throw httpError(400, code, code);
  return v;
}

export function parseAdminPagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const { page, limit, skip } = parsePaginationUtil(query || {}, {
    defaultLimit,
    maxLimit,
  });
  return { page, limit, skip };
}

export function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSearchOrFilter(q, fields) {
  const termRaw = String(q || "").trim();
  if (!termRaw) return null;

  // Safety: avoid costly unbounded regex + garbage queries
  const term = termRaw.length > 64 ? termRaw.slice(0, 64) : termRaw;
  if (term.length < 2) return null;

  const safe = escapeRegex(term);
  if (!safe) return null;

  const re = new RegExp(safe, "i");
  const or = (Array.isArray(fields) ? fields : [])
    .filter((f) => typeof f === "string" && f.trim().length)
    .slice(0, 20)
    .map((path) => ({ [path]: re }));

  return or.length ? { $or: or } : null;
}

/**
 * sortString supports:
 * - "createdAt" or "-createdAt"
 * - Allow-lists fields, optionally mapping API field -> DB field
 */
export function parseSort(sortString, allowList, { fieldMap = {}, defaultSort } = {}) {
  const raw = String(sortString || "").trim();
  const defaultOut = defaultSort || { createdAt: -1, _id: -1 };

  if (!raw) return defaultOut;

  const desc = raw.startsWith("-");
  const key = desc ? raw.slice(1) : raw;
  const allowed = new Set(Array.isArray(allowList) ? allowList : []);
  if (!allowed.has(key)) return defaultOut;

  const mapped = fieldMap[key] || key;
  const dir = desc ? -1 : 1;

  // Stable tie-breaker for pagination
  if (mapped === "_id") return { _id: dir };
  return { [mapped]: dir, _id: dir };
}

export function buildListEnvelope({ items, page, limit, total }) {
  const safeTotal = Number.isFinite(Number(total)) ? Number(total) : 0;
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 1;
  return {
    items: Array.isArray(items) ? items : [],
    page: Number.isFinite(Number(page)) ? Number(page) : 1,
    limit: safeLimit,
    total: safeTotal,
    pages: Math.ceil(safeTotal / safeLimit),
  };
}
