import { LeaseLock } from "../models/LeaseLock.js";
import { ENV } from "../utils/env.js";

function ttlMs() {
  return Math.max(5000, Number(ENV.LEASE_TTL_MS || 20000));
}

export async function tryAcquireLease({ name, ownerId }) {
  const now = new Date();
  const until = new Date(Date.now() + ttlMs());

  try {
    const doc = await LeaseLock.findOneAndUpdate(
      { name, $or: [{ lockedUntil: { $lte: now } }, { ownerId }] },
      { $set: { ownerId, lockedUntil: until } },
      { new: true, upsert: true },
    ).lean();

    return doc?.ownerId === ownerId && doc.lockedUntil > now;
  } catch {
    // possible upsert race
    const doc = await LeaseLock.findOne({ name }).lean();
    return doc?.ownerId === ownerId && doc.lockedUntil > now;
  }
}

export async function renewLease({ name, ownerId }) {
  const until = new Date(Date.now() + ttlMs());
  const res = await LeaseLock.updateOne({ name, ownerId }, { $set: { lockedUntil: until } });
  return res.modifiedCount === 1;
}
