import { User } from "../models/User.js";

/**
 * Tier thresholds based on cumulative B2B spending (ILS).
 * A user's tier auto-upgrades when totalB2BSpent reaches the threshold.
 * Tiers only move upward — never downgrade automatically.
 */
const TIER_THRESHOLDS = [
  { tier: "gold", minSpent: 50000 },
  { tier: "silver", minSpent: 15000 },
  { tier: "bronze", minSpent: 0 },
];

const TIER_ORDER = { none: 0, bronze: 1, silver: 2, gold: 3 };

function tierRank(tier) {
  return TIER_ORDER[tier] ?? 0;
}

/**
 * After a B2B order is confirmed, call this to:
 * 1. Increment totalB2BSpent
 * 2. Evaluate and potentially upgrade the tier
 *
 * @param {string} userId
 * @param {number} orderTotalMajor - order total in ILS (major units)
 * @returns {{ upgraded: boolean, previousTier: string, newTier: string }}
 */
export async function evaluateTierProgression(userId, orderTotalMajor) {
  const user = await User.findById(userId).select(
    "b2bApproved wholesaleTier totalB2BSpent tierLockedByAdmin",
  );
  if (!user || !user.b2bApproved) {
    return { upgraded: false, previousTier: "none", newTier: "none" };
  }

  const previousTier = user.wholesaleTier || "none";

  user.totalB2BSpent = (user.totalB2BSpent || 0) + orderTotalMajor;

  if (user.tierLockedByAdmin) {
    await user.save();
    return { upgraded: false, previousTier, newTier: previousTier };
  }

  let targetTier = previousTier;
  for (const threshold of TIER_THRESHOLDS) {
    if (user.totalB2BSpent >= threshold.minSpent) {
      if (tierRank(threshold.tier) > tierRank(targetTier)) {
        targetTier = threshold.tier;
      }
      break;
    }
  }

  const upgraded = tierRank(targetTier) > tierRank(previousTier);
  if (upgraded) {
    user.wholesaleTier = targetTier;
  }

  await user.save();
  return { upgraded, previousTier, newTier: user.wholesaleTier };
}

/**
 * Recalculate a user's totalB2BSpent from their order history.
 * Useful for admin corrections or data migration.
 */
export async function recalculateTotalSpent(userId) {
  const Order = (await import("../models/Order.js")).Order;
  const result = await Order.aggregate([
    {
      $match: {
        userId: (await import("mongoose")).default.Types.ObjectId.createFromHexString(userId),
        isB2B: true,
        status: { $nin: ["cancelled", "refunded"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$totalPrice" } } },
  ]);

  const total = result[0]?.total || 0;
  await User.findByIdAndUpdate(userId, { totalB2BSpent: total });
  return total;
}
