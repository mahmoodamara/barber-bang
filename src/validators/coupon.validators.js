// src/validators/coupon.validators.js
import { z } from "zod";
import { objectId } from "./_common.js";

/**
 * Fix:
 * - Keep a RAW ZodObject schema (so .shape exists)
 * - Apply superRefine on top of it
 */

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z0-9][A-Z0-9_-]*$/.test(v), "Invalid coupon code format");

const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "currency must be a 3-letter code (e.g. ILS)")
  .optional();

const moneyMajor = z.number().finite().nonnegative();
const moneyMinor = z.number().int().nonnegative();

const dateStr = z.string().datetime();

function enforceUnitExclusivity(body, ctx, a, b, msg) {
  if (body?.[a] !== undefined && body?.[b] !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["body", b],
      message: msg,
    });
  }
}

/* ---------------------------- */
/* User apply coupon            */
/* ---------------------------- */

export const applyCouponSchema = z.object({
  body: z.object({
    code: codeSchema,
  }),
});

/* ---------------------------- */
/* Admin create/update          */
/* ---------------------------- */

// RAW body schema (no superRefine here)
const createCouponBodySchema = z.object({
  code: codeSchema,
  type: z.enum(["percent", "fixed"]),
  value: z.number().finite().optional(),
  valueMinor: moneyMinor.optional(),

  currency: currencySchema,

  minOrderTotal: moneyMajor.optional(),
  minOrderTotalMinor: moneyMinor.optional(),

  maxUsesTotal: z.number().int().positive().nullable().optional(),
  maxUsesPerUser: z.number().int().min(0).nullable().optional(),

  allowedUserIds: z.array(objectId).max(200).optional(),
  allowedRoles: z.array(z.string().trim().min(1).max(40)).max(50).optional(),

  startsAt: dateStr.nullable().optional(),
  endsAt: dateStr.nullable().optional(),

  isActive: z.boolean().optional(),
});

// RAW wrapper schema (IMPORTANT: this is ZodObject, so .shape exists)
const createCouponSchemaRaw = z.object({
  body: createCouponBodySchema,
});

export const createCouponSchema = createCouponSchemaRaw.superRefine((val, ctx) => {
  const b = val.body;

  // prevent ambiguous money units
  enforceUnitExclusivity(b, ctx, "value", "valueMinor", "COUPON_AMBIGUOUS_UNIT_VALUE");
  enforceUnitExclusivity(
    b,
    ctx,
    "minOrderTotal",
    "minOrderTotalMinor",
    "COUPON_AMBIGUOUS_UNIT_MIN_ORDER_TOTAL",
  );

  // type-specific validation
  if (b.type === "percent") {
    if (b.valueMinor !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body", "valueMinor"],
        message: "COUPON_INVALID_UNIT_PERCENT",
      });
    }
    if (b.value === undefined || b.value === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body", "value"],
        message: "COUPON_VALUE_REQUIRED",
      });
    } else {
      const pct = Number(b.value);
      if (!(pct > 0 && pct <= 100)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body", "value"],
          message: "COUPON_INVALID_PERCENT",
        });
      }
    }
  }

  if (b.type === "fixed") {
    const hasMajor = b.value !== undefined && b.value !== null;
    const hasMinor = b.valueMinor !== undefined && b.valueMinor !== null;

    if (!hasMajor && !hasMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body", "value"],
        message: "COUPON_VALUE_REQUIRED",
      });
    }
    if (hasMajor) {
      const v = Number(b.value);
      if (!(Number.isFinite(v) && v > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body", "value"],
          message: "COUPON_INVALID_FIXED_VALUE",
        });
      }
    }
    if (hasMinor) {
      const v = Number(b.valueMinor);
      if (!(Number.isInteger(v) && v > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body", "valueMinor"],
          message: "COUPON_INVALID_FIXED_VALUE_MINOR",
        });
      }
    }
  }

  // date ordering
  if (b.startsAt && b.endsAt) {
    const s = new Date(b.startsAt).getTime();
    const e = new Date(b.endsAt).getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && s > e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body", "endsAt"],
        message: "COUPON_INVALID_DATE_RANGE",
      });
    }
  }
});

// ✅ Update uses the RAW body schema (not the refined one)
export const updateCouponSchema = z
  .object({
    body: createCouponSchemaRaw.shape.body.partial().extend({
      startsAt: dateStr.nullable().optional(),
      endsAt: dateStr.nullable().optional(),
    }),
  })
  .superRefine((val, ctx) => {
    const b = val.body || {};

    // prevent ambiguous units (even in partial update)
    enforceUnitExclusivity(b, ctx, "value", "valueMinor", "COUPON_AMBIGUOUS_UNIT_VALUE");
    enforceUnitExclusivity(
      b,
      ctx,
      "minOrderTotal",
      "minOrderTotalMinor",
      "COUPON_AMBIGUOUS_UNIT_MIN_ORDER_TOTAL",
    );

    // If changing type, require providing a value/valueMinor in same request
    if (b.type !== undefined) {
      const hasMajor = b.value !== undefined && b.value !== null;
      const hasMinor = b.valueMinor !== undefined && b.valueMinor !== null;
      if (!hasMajor && !hasMinor) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body", "value"],
          message: "COUPON_VALUE_REQUIRED_WHEN_CHANGING_TYPE",
        });
      }
    }

    // If type explicitly provided in patch, validate shape accordingly
    if (b.type === "percent") {
      if (b.valueMinor !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body", "valueMinor"],
          message: "COUPON_INVALID_UNIT_PERCENT",
        });
      }
      if (b.value !== undefined) {
        const pct = Number(b.value);
        if (!(pct > 0 && pct <= 100)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["body", "value"],
            message: "COUPON_INVALID_PERCENT",
          });
        }
      }
    }

    if (b.type === "fixed") {
      if (b.value !== undefined) {
        const v = Number(b.value);
        if (!(Number.isFinite(v) && v > 0)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["body", "value"],
            message: "COUPON_INVALID_FIXED_VALUE",
          });
        }
      }
      if (b.valueMinor !== undefined) {
        const v = Number(b.valueMinor);
        if (!(Number.isInteger(v) && v > 0)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["body", "valueMinor"],
            message: "COUPON_INVALID_FIXED_VALUE_MINOR",
          });
        }
      }
    }

    // date ordering
    if (b.startsAt && b.endsAt) {
      const s = new Date(b.startsAt).getTime();
      const e = new Date(b.endsAt).getTime();
      if (Number.isFinite(s) && Number.isFinite(e) && s > e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body", "endsAt"],
          message: "COUPON_INVALID_DATE_RANGE",
        });
      }
    }
  });
