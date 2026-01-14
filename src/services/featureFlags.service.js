import crypto from "crypto";
import { FeatureFlag } from "../models/FeatureFlag.js";
import { ENV } from "../utils/env.js";

let cache = { at: 0, ms: 0, flags: new Map() };

function cacheMs() {
  return Math.max(1000, Number(ENV.FEATURE_FLAGS_CACHE_MS || 15000));
}

function hashToPct(input) {
  const h = crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
  const n = parseInt(h, 16);
  return (n % 10000) / 100; // 0..99.99
}

export async function loadFlags() {
  const ttl = cacheMs();
  const now = Date.now();
  if (cache.flags.size && now - cache.at < ttl) return cache.flags;

  const docs = await FeatureFlag.find({}).lean();
  const map = new Map();
  for (const d of docs) map.set(d.key, d);

  cache = { at: now, ms: ttl, flags: map };
  return map;
}

export async function isEnabled(key, ctx) {
  const flags = await loadFlags();
  const f = flags.get(key);
  if (!f || !f.enabled) return false;

  const role = ctx?.role || "user";
  const userId = ctx?.userId ? String(ctx.userId) : null;

  // 1) allowlist override
  if (Array.isArray(f.allowUserIds) && f.allowUserIds.length && userId) {
    const allowed = f.allowUserIds.map(String).includes(userId);
    if (allowed) return true;
  }

  // 2) role gating
  if (Array.isArray(f.rolesAllow) && f.rolesAllow.length) {
    if (!f.rolesAllow.includes(role)) return false;
  }

  // 3) rollout
  const rollout = Number(f.rollout || 0);
  if (rollout <= 0) return true;
  if (rollout >= 100) return true;
  if (!userId) return false;

  const pct = hashToPct(`${key}:${userId}`);
  return pct < rollout;
}

export async function upsertFlag({ key, enabled, rolesAllow, rollout, description, updatedBy }) {
  await FeatureFlag.updateOne(
    { key },
    {
      $set: {
        enabled: Boolean(enabled),
        rolesAllow: Array.isArray(rolesAllow) ? rolesAllow : [],
        rollout: Number.isFinite(rollout) ? Math.max(0, Math.min(100, rollout)) : 0,
        description: description || "",
        updatedBy: updatedBy || null,
      },
    },
    { upsert: true },
  );

  // bust cache
  cache = { at: 0, ms: cacheMs(), flags: new Map() };
}
