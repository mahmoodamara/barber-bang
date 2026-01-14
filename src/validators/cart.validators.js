// src/validators/cart.validators.js
import { z } from "zod";
import { objectId } from "./common.validators.js";

export const cartQuerySchema = z.object({
  expand: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  lang: z.enum(["he", "ar"]).optional().default("he"),
});

export const addCartItemSchema = z.object({
  productId: objectId,
  variantId: objectId.optional().nullable(),
  qty: z.coerce.number().int().min(1).max(99).optional().default(1),
});

export const updateCartItemQtySchema = z.object({
  qty: z.coerce.number().int().min(1).max(99),
});

export const removeCartItemQuerySchema = z.object({
  variantId: objectId.optional(),
});
