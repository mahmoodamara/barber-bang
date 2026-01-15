// src/validators/shipping.validators.js
import { z } from "zod";
import { objectId } from "./_common.js";

/**
 * Hardening goals:
 * - Match validate(...) convention: { params, query, body }
 * - Normalize lang/city/code
 * - Avoid ambiguous money units on admin create/update:
 *   accept either major (basePrice/freeAbove/minSubtotal/maxSubtotal) OR minor equivalents
 *   (recommended) — here we keep MAJOR only at validator level, but enforce finiteness + bounds.
 * - Enforce code charset (no spaces)
 * - Cities: trim + cap, and forbid duplicates at validator level (service also normalizes)
 * - setOrderShippingMethod: require orderId param (recommended) + body
 */

const trimmed = (min, max) => z.string().trim().min(min).max(max);

const codeSchema = z
  .string()
  .trim()
  .min(2)
  .max(50)
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z0-9][A-Z0-9_-]*$/.test(v), "Invalid code format");

const citySchema = z
  .string()
  .trim()
  .max(120)
  .transform((v) => v.replace(/\s+/g, " "));

const moneyMajor = z
  .number()
  .finite()
  .min(0)
  .max(1_000_000, "Value too large");

const nullableMoneyMajor = moneyMajor.nullable().optional().default(null);

const citiesSchema = z
  .array(trimmed(1, 120))
  .max(500)
  .optional()
  .default([])
  .transform((arr) => arr.map((c) => c.trim()))
  .superRefine((arr, ctx) => {
    // basic duplicate detection (case-insensitive); service will normalize to lowercase anyway
    const seen = new Set();
    for (let i = 0; i < arr.length; i += 1) {
      const key = String(arr[i]).trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: "DUPLICATE_CITY",
        });
      }
      seen.add(key);
    }
  });

/* ---------------------------- */
/* Public/user list methods      */
/* ---------------------------- */

export const listShippingMethodsQuerySchema = z.object({
  query: z
    .object({
      lang: z.enum(["he", "ar"]).optional().default("he"),
      payableSubtotalMinor: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
      // Backward compatibility: accept legacy query name.
      payableSubtotal: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
      city: citySchema.optional(),
    })
    .strict(),
}).strict();

/* ---------------------------- */
/* User set method on order      */
/* ---------------------------- */

export const setOrderShippingMethodSchema = z.object({
  params: z.object({
    id: objectId, // orderId (match route: /orders/:id/shipping-method for example)
  }),
  body: z.object({
    shippingMethodId: objectId,
  }),
});

/* ---------------------------- */
/* Admin shipping method CRUD    */
/* ---------------------------- */

export const createShippingMethodSchema = z.object({
  body: z.object({
    code: codeSchema,

    nameHe: trimmed(1, 120),
    nameAr: trimmed(1, 120),

    descHe: trimmed(0, 400).optional().default(""),
    descAr: trimmed(0, 400).optional().default(""),

    // IMPORTANT:
    // Your DB appears to store shipping amounts in minor units (ints).
    // This schema validates MAJOR input (number), service must convert to minor.
    basePrice: moneyMajor,
    freeAbove: nullableMoneyMajor,
    minSubtotal: nullableMoneyMajor,
    maxSubtotal: nullableMoneyMajor,

    // Normalize cities in service/controller to lowercase-trim (you already do),
    // but we still validate shape + prevent duplicates here.
    cities: citiesSchema,

    sort: z.number().int().min(0).max(10000).optional().default(100),
    isActive: z.boolean().optional().default(true),
  }),
});

export const updateShippingMethodSchema = z.object({
  params: z.object({
    id: objectId, // shippingMethodId
  }),
  body: createShippingMethodSchema.shape.body.partial(),
});
