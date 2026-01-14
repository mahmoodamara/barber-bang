// src/validators/refund.validators.js
import { z } from "zod";
import { objectId } from "./_common.js";

/**
 * Hardening goals:
 * - Validate orderId/variantId as ObjectId (fail fast, avoid cast errors)
 * - Normalize/trim reason
 * - Keep amount as integer minor units with reasonable upper bound (blast-radius control)
 * - Validate restockItems: unique variantId, clamp list size
 * - Require restockItems only when restock===true (optional policy, but safer)
 * - Disallow sending restockItems when restock===false
 */

const trimmed = (min, max) => z.string().trim().min(min).max(max);

const MAX_REFUND_MINOR = 1_000_000_000; // safety cap; real cap should be enforced vs order totals in service
const MAX_RESTOCK_ITEMS = 200;

export const adminRefundSchema = z
  .object({
    params: z.object({
      id: objectId, // orderId
    }),
    body: z.object({
      // minor units integer; if omitted => full remaining (service decides)
      amount: z
        .number()
        .int()
        .positive()
        .max(MAX_REFUND_MINOR, "amount too large")
        .optional(),

      reason: trimmed(0, 300).optional().nullable(),

      restock: z.boolean().optional(),

      restockItems: z
        .array(
          z.object({
            variantId: objectId,
            quantity: z.number().int().positive().max(100_000, "quantity too large"),
          }),
        )
        .max(MAX_RESTOCK_ITEMS)
        .optional(),
    }),
  })
  .superRefine((val, ctx) => {
    const b = val.body || {};
    const restock = b.restock === true;
    const items = Array.isArray(b.restockItems) ? b.restockItems : [];

    // If restockItems exist, ensure uniqueness by variantId
    if (items.length) {
      const set = new Set();
      for (let i = 0; i < items.length; i += 1) {
        const vid = String(items[i]?.variantId || "");
        if (set.has(vid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["body", "restockItems", i, "variantId"],
            message: "DUPLICATE_VARIANT_IN_RESTOCK_ITEMS",
          });
        }
        set.add(vid);
      }
    }

    // Policy: restockItems only meaningful when restock is true
    if (!restock && items.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body", "restockItems"],
        message: "RESTOCK_ITEMS_NOT_ALLOWED_WHEN_RESTOCK_FALSE",
      });
    }

    // Optional policy: if restock=true and you provided restockItems, allow partial; if restock=true without items -> service will use default/full logic
    // If you want to enforce that restock=true MUST include restockItems for partial, keep it in service logic, not validator.
  });
