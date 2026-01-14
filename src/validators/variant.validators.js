// src/validators/variant.validators.js
import { z } from "zod";
import { objectId } from "./_common.js";

/**
 * Hardening goals:
 * - Trim/normalize strings (sku/barcode/currency)
 * - Enforce SKU format + length + whitespace rules
 * - Enforce currency format (3-letter ISO-like) if provided
 * - Make options JSON-safe (no record(any))
 * - Stock and price constraints that match business reality
 * - Stock adjust: delta must be non-zero, clamp magnitude, normalize reason
 */

const trimmed = (min, max) => z.string().trim().min(min).max(max);

const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // allow letters/numbers and common separators; reject spaces-only / weird chars
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-:/]*$/, "Invalid SKU format");

const barcodeSchema = z
  .string()
  .trim()
  .max(80)
  .regex(/^[0-9A-Za-z._\-]*$/, "Invalid barcode format");

const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "currency must be a 3-letter code (e.g. ILS)")
  .optional();

// Safe JSON-like schema for options (avoid record(any))
const jsonPrimitive = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const jsonValue = z.lazy(() =>
  z.union([
    jsonPrimitive,
    z.array(jsonValue).max(100),
    z.record(z.string().max(80), jsonValue),
  ]),
);

const optionsSchema = z
  .record(z.string().max(80), jsonValue)
  .optional()
  .refine(
    (obj) => {
      const keys = obj ? Object.keys(obj) : [];
      return keys.length <= 80;
    },
    { message: "options has too many keys (max 80)" },
  );

// Price is in major units in the API input, later converted to minor units in service.
// Keep it finite and within a reasonable range to prevent accidental huge values.
const priceSchema = z
  .number()
  .finite()
  .min(0)
  .max(1_000_000, "price is too large");

const stockSchema = z
  .number()
  .int()
  .min(0)
  .max(1_000_000, "stock is too large");

export const createVariantSchema = z.object({
  params: z.object({ productId: objectId }),
  body: z.object({
    sku: skuSchema,
    barcode: barcodeSchema.optional().nullable(),
    price: priceSchema,
    currency: currencySchema,

    stock: stockSchema.optional(),

    options: optionsSchema,

    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  }),
});

export const updateVariantSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    sku: skuSchema.optional(),
    barcode: barcodeSchema.optional().nullable(),
    price: priceSchema.optional(),
    currency: currencySchema,

    stock: stockSchema.optional(),

    options: optionsSchema,

    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  }),
});

export const adjustStockSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    // delta must be non-zero; clamp magnitude to reduce blast radius on mistakes
    delta: z
      .number()
      .int()
      .refine((n) => n !== 0, "delta cannot be 0")
      .refine((n) => Math.abs(n) <= 100_000, "delta magnitude is too large"),
    reason: trimmed(1, 300),
  }),
});
