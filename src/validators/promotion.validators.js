import { z } from "zod";
import { objectId } from "./_common.js";

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z0-9][A-Z0-9_-]*$/.test(v), "INVALID_PROMO_CODE");

const dateStr = z.string().datetime();
const minorInt = z.number().int().min(0);

const typeEnum = z.enum(["PERCENT", "FIXED", "FREE_SHIPPING"]);
const stackingEnum = z.enum(["EXCLUSIVE", "STACKABLE", "STACKABLE_SAME_PRIORITY_ONLY"]);
const targetingModeEnum = z.enum(["ALL", "WHITELIST", "SEGMENTS", "ROLES"]);

const scopeSideSchema = z.object({
  products: z.array(objectId).max(200).optional(),
  categories: z.array(objectId).max(200).optional(),
  brands: z.array(z.string().trim().min(1).max(140)).max(200).optional(),
});

const promotionBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  type: typeEnum,
  value: z.number().optional(),

  code: codeSchema.optional().nullable(),
  autoApply: z.boolean().optional(),

  startsAt: dateStr.nullable().optional(),
  endsAt: dateStr.nullable().optional(),
  isActive: z.boolean().optional(),

  priority: z.number().int().optional(),
  stackingPolicy: stackingEnum.optional(),

  eligibility: z
    .object({
      minSubtotalMinor: minorInt.optional(),
      maxDiscountMinor: minorInt.nullable().optional(),
      cities: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
    })
    .optional(),

  scope: z
    .object({
      storewide: z.boolean().optional(),
      include: scopeSideSchema.optional(),
      exclude: scopeSideSchema.optional(),
    })
    .optional(),

  targeting: z
    .object({
      mode: targetingModeEnum.optional(),
      allowedUserIds: z.array(objectId).max(200).optional(),
      allowedSegments: z.array(z.string().trim().min(1).max(40)).max(100).optional(),
      allowedRoles: z.array(z.string().trim().min(1).max(40)).max(100).optional(),
    })
    .optional(),

  limits: z
    .object({
      maxUsesTotal: minorInt.nullable().optional(),
      maxUsesPerUser: minorInt.nullable().optional(),
    })
    .optional(),
});

export const createPromotionSchema = z
  .object({
    body: promotionBodySchema,
  })
  .superRefine((val, ctx) => {
    const b = val.body || {};
    const type = b.type;

    if (type === "PERCENT") {
      if (b.value === undefined || b.value === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "value"], message: "PROMO_VALUE_REQUIRED" });
      } else {
        const pct = Number(b.value);
        if (!(pct > 0 && pct <= 100)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "value"], message: "PROMO_INVALID_PERCENT" });
        }
      }
    }

    if (type === "FIXED") {
      if (b.value === undefined || b.value === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "value"], message: "PROMO_VALUE_REQUIRED" });
      } else if (!Number.isInteger(b.value) || b.value < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "value"], message: "PROMO_INVALID_FIXED_VALUE" });
      }
    }

    if (type === "FREE_SHIPPING" && b.value !== undefined && b.value !== null) {
      const v = Number(b.value);
      if (!Number.isFinite(v) || v < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "value"], message: "PROMO_INVALID_VALUE" });
      }
    }

    if (b.startsAt && b.endsAt) {
      const s = new Date(b.startsAt).getTime();
      const e = new Date(b.endsAt).getTime();
      if (Number.isFinite(s) && Number.isFinite(e) && s > e) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "endsAt"], message: "PROMO_INVALID_DATE_RANGE" });
      }
    }
  });

export const updatePromotionSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
    body: promotionBodySchema.partial(),
  })
  .superRefine((val, ctx) => {
    const b = val.body || {};
    const type = b.type;

    if (!Object.keys(b).length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "EMPTY_UPDATE" });
    }

    if (type !== undefined && type !== "FREE_SHIPPING" && b.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body", "value"],
        message: "PROMO_VALUE_REQUIRED_WHEN_CHANGING_TYPE",
      });
    }

    if (type === "PERCENT" && b.value !== undefined) {
      const pct = Number(b.value);
      if (!(pct > 0 && pct <= 100)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "value"], message: "PROMO_INVALID_PERCENT" });
      }
    }

    if (type === "FIXED" && b.value !== undefined) {
      if (!Number.isInteger(b.value) || b.value < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "value"], message: "PROMO_INVALID_FIXED_VALUE" });
      }
    }

    if (type === "FREE_SHIPPING" && b.value !== undefined && b.value !== null) {
      const v = Number(b.value);
      if (!Number.isFinite(v) || v < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "value"], message: "PROMO_INVALID_VALUE" });
      }
    }

    if (b.startsAt && b.endsAt) {
      const s = new Date(b.startsAt).getTime();
      const e = new Date(b.endsAt).getTime();
      if (Number.isFinite(s) && Number.isFinite(e) && s > e) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "endsAt"], message: "PROMO_INVALID_DATE_RANGE" });
      }
    }
  });

export const adminPromotionIdParamsSchema = z.object({
  params: z.object({ id: objectId }).strict(),
});

export const adminPromotionPreviewSchema = z.object({
  params: z.object({ id: objectId }).strict(),
  body: z.object({
    items: z
      .array(
        z.object({
          variantId: objectId,
          quantity: z.number().int().min(1).max(50),
          unitPriceMinor: minorInt.optional(),
        }),
      )
      .min(1)
      .max(100),
    userId: objectId.optional(),
    roles: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
    segments: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
    city: z.string().trim().max(120).optional(),
    code: z.string().trim().max(60).optional(),
    shippingMinor: minorInt.optional(),
  }),
});
