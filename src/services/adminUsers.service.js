import { User } from "../models/User.js";
import { PasswordResetToken } from "../models/PasswordResetToken.js";

import { applyQueryBudget } from "../utils/queryBudget.js";
import {
  buildListEnvelope,
  buildSearchOrFilter,
  parseAdminPagination,
  parseSort,
} from "../utils/adminQuery.js";
import { generateToken, getPasswordResetTtlMs, hashToken } from "../utils/authTokens.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function getPrimaryRole(roles) {
  const list = Array.isArray(roles) ? roles.filter(Boolean).map(String) : [];
  if (list.includes("admin")) return "admin";
  if (list.includes("staff")) return "staff";
  return "user";
}

function getDefaultAddress(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  if (!list.length) return null;
  return list.find((a) => a?.isDefault) || list[0] || null;
}

function normalizeSegments(segments) {
  const raw = Array.isArray(segments) ? segments : [];
  const seen = new Set();
  const out = [];
  for (const seg of raw) {
    const v = String(seg || "").trim().toUpperCase();
    if (!v) continue;
    if (v.length > 40) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 50) break;
  }
  return out;
}

export function toAdminUserDTO(docOrLean) {
  if (!docOrLean) return docOrLean;
  const d = typeof docOrLean.toObject === "function" ? docOrLean.toObject() : docOrLean;

  const addr = getDefaultAddress(d.addresses);
  const name = addr?.fullName ? String(addr.fullName).trim() : null;

  return {
    id: String(d._id || d.id),
    _id: d._id || d.id,
    name,
    email: d.email || null,
    phone: d.phone || (addr?.phone ? String(addr.phone).trim() : null),
    roles: Array.isArray(d.roles) ? d.roles : [],
    segments: Array.isArray(d.segments) ? d.segments : [],
    role: getPrimaryRole(d.roles),
    permissions: Array.isArray(d.permissions) ? d.permissions : [],
    isActive: !!d.isActive,
    emailVerified: !!d.emailVerified,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    lastLoginAt: d.lastLoginAt || null,
  };
}

export async function adminListUsers({ q }) {
  const { page, limit, skip } = parseAdminPagination(q, { defaultLimit: 20, maxLimit: 100 });

  const filter = {};

  if (q.role) filter.roles = String(q.role);
  if (q.isActive === true || q.isActive === false) filter.isActive = q.isActive;
  if (q.emailVerified === true || q.emailVerified === false) filter.emailVerified = q.emailVerified;

  const search = buildSearchOrFilter(q.q, ["emailLower", "email", "phone", "addresses.fullName"]);
  if (search) Object.assign(filter, search);

  const sort = parseSort(
    q.sort,
    ["createdAt", "email", "name", "lastLoginAt"],
    {
      fieldMap: {
        email: "emailLower",
        name: "addresses.fullName",
        lastLoginAt: "lastLoginAt",
      },
      defaultSort: { createdAt: -1, _id: -1 },
    },
  );

  const fields =
    "email emailLower phone roles segments permissions isActive emailVerified createdAt updatedAt lastLoginAt addresses";

  const [items, total] = await Promise.all([
    applyQueryBudget(
      User.find(filter).select(fields).sort(sort).skip(skip).limit(limit).lean(),
    ),
    applyQueryBudget(User.countDocuments(filter)),
  ]);

  return buildListEnvelope({
    items: items.map(toAdminUserDTO),
    page,
    limit,
    total,
  });
}

export async function adminGetUser(userId) {
  const fields =
    "email emailLower phone roles segments permissions isActive emailVerified createdAt updatedAt lastLoginAt addresses";

  const user = await applyQueryBudget(
    User.findById(userId).select(fields).lean(),
  );
  if (!user) throw httpError(404, "USER_NOT_FOUND", "User not found");
  return toAdminUserDTO(user);
}

export async function adminUpdateUser(userId, patch) {
  const set = {};
  const inc = {};

  const wantsRole = patch.role !== undefined;
  const wantsActive = patch.isActive !== undefined;
  const wantsEmailVerified = patch.emailVerified !== undefined;
  const wantsPermissions = patch.permissions !== undefined;
  const wantsSegments = patch.segments !== undefined;

  if (wantsRole) {
    set.roles = [String(patch.role)];
    inc.tokenVersion = 1;
  }

  if (wantsActive) {
    set.isActive = !!patch.isActive;
    inc.tokenVersion = 1;
  }

  if (wantsEmailVerified) {
    const ev = !!patch.emailVerified;
    set.emailVerified = ev;
    set.emailVerifiedAt = ev ? new Date() : null;
  }

  if (wantsPermissions) {
    const raw = Array.isArray(patch.permissions) ? patch.permissions : [];
    const uniq = [];
    const seen = new Set();
    for (const p of raw) {
      if (typeof p !== "string") continue;
      const v = p.trim();
      if (!v) continue;
      if (v.length > 80) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      uniq.push(v);
      if (uniq.length >= 200) break;
    }
    set.permissions = uniq;
    inc.tokenVersion = 1;
  }

  if (wantsSegments) {
    set.segments = normalizeSegments(patch.segments);
  }

  const update = {
    ...(Object.keys(set).length ? { $set: set } : {}),
    ...(Object.keys(inc).length ? { $inc: inc } : {}),
  };

  const fields =
    "email emailLower phone roles segments permissions isActive emailVerified createdAt updatedAt lastLoginAt addresses";

  const updated = await User.findByIdAndUpdate(userId, update, {
    new: true,
    runValidators: true,
    context: "query",
    select: fields,
  }).lean();

  if (!updated) throw httpError(404, "USER_NOT_FOUND", "User not found");
  return toAdminUserDTO(updated);
}

export async function adminCreatePasswordResetToken(userId, { ip, userAgent } = {}) {
  const user = await User.findById(userId).select("emailLower isActive").lean();
  if (!user) throw httpError(404, "USER_NOT_FOUND", "User not found");
  if (!user.isActive) throw httpError(409, "USER_INACTIVE", "User is inactive");

  const emailLower = String(user.emailLower || "").trim().toLowerCase();
  if (!emailLower) {
    throw httpError(409, "USER_EMAIL_REQUIRED", "User does not have an email set");
  }

  const now = new Date();
  const ttlMs = Math.min(getPasswordResetTtlMs(), 15 * 60_000);
  const expiresAt = new Date(now.getTime() + ttlMs);

  const token = generateToken();
  const tokenHash = hashToken(token);

  await PasswordResetToken.deleteMany({ userId: user._id });
  await PasswordResetToken.create({
    userId: user._id,
    tokenHash,
    createdAt: now,
    expiresAt,
    usedAt: null,
    ip: typeof ip === "string" ? ip.trim().slice(0, 64) : null,
    userAgent: typeof userAgent === "string" ? userAgent.trim().slice(0, 200) : null,
  });

  return { token, expiresAt };
}
