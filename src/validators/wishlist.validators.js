// src/validators/wishlist.validators.js
import { z } from "zod";
import { objectId } from "./common.validators.js";

export const addWishlistItemSchema = z.object({
  productId: objectId,
  variantId: objectId.optional().nullable(),
});

export const removeWishlistItemSchema = z.object({
  productId: objectId,
  variantId: objectId.optional().nullable(),
});

export const wishlistQuerySchema = z.object({
  lang: z.enum(["he", "ar"]).optional(),
  expand: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});
