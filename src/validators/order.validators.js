import { z } from "zod";
import { objectId } from "./_common.js";

export const createOrderSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          variantId: objectId,
          quantity: z.number().int().min(1).max(50),
        }),
      )
      .min(1)
      .max(50),

    shippingAddress: z
      .object({
        fullName: z.string().max(120).optional().nullable(),
        phone: z.string().max(40).optional().nullable(),
        country: z.string().max(80).optional().nullable(),
        city: z.string().max(120).optional().nullable(),
        street: z.string().max(120).optional().nullable(),
        building: z.string().max(40).optional().nullable(),
        apartment: z.string().max(40).optional().nullable(),
        zip: z.string().max(30).optional().nullable(),
        postalCode: z.string().max(30).optional().nullable(),
        notes: z.string().max(500).optional().nullable(),
      })
      .optional()
      .nullable(),

    billingAddress: z
      .object({
        fullName: z.string().max(120).optional().nullable(),
        phone: z.string().max(40).optional().nullable(),
        country: z.string().max(80).optional().nullable(),
        city: z.string().max(120).optional().nullable(),
        street: z.string().max(120).optional().nullable(),
        building: z.string().max(40).optional().nullable(),
        apartment: z.string().max(40).optional().nullable(),
        zip: z.string().max(30).optional().nullable(),
        postalCode: z.string().max(30).optional().nullable(),
        notes: z.string().max(500).optional().nullable(),
      })
      .optional()
      .nullable(),

    // Newer shape (preferred)
    shippingMethodId: objectId.optional().nullable(),

    // Coupon: accept multiple compatible shapes to preserve legacy clients
    couponCode: z.string().max(50).optional().nullable(),
    coupon: z.union([z.string().max(50), z.object({ code: z.string().max(50) })]).optional().nullable(),

    // Promotion code (separate from coupons)
    promotionCode: z.string().max(60).optional().nullable(),
    promoCode: z.string().max(60).optional().nullable(),
  }),
});

export const orderIdSchema = z.object({
  params: z.object({
    id: objectId,
  }),
});

export const checkoutSchema = z.object({
  params: z.object({
    id: objectId,
  }),
  body: z
    .object({
      provider: z.enum(["stripe", "cod"]).optional(),
    })
    .optional(),
});

export const orderQuoteSchema = z.object({
  params: z.object({
    id: objectId,
  }),
  query: z
    .object({
      lang: z.enum(["he", "ar"]).optional(),
    })
    .optional(),
});

export const updateOrderAddressSchema = z
  .object({
    params: z.object({
      id: objectId,
    }),
    body: z
      .object({
        shippingAddressId: objectId.optional().nullable(),
        billingAddressId: objectId.optional().nullable(),

        shippingAddress: z
          .object({
            fullName: z.string().max(120).optional().nullable(),
            phone: z.string().max(40).optional().nullable(),
            country: z.string().max(80).optional().nullable(),
            city: z.string().max(120).optional().nullable(),
            street: z.string().max(200).optional().nullable(),
            building: z.string().max(50).optional().nullable(),
            apartment: z.string().max(50).optional().nullable(),
            zip: z.string().max(30).optional().nullable(),
            postalCode: z.string().max(30).optional().nullable(),
            notes: z.string().max(500).optional().nullable(),
          })
          .optional()
          .nullable(),

        billingAddress: z
          .object({
            fullName: z.string().max(120).optional().nullable(),
            phone: z.string().max(40).optional().nullable(),
            country: z.string().max(80).optional().nullable(),
            city: z.string().max(120).optional().nullable(),
            street: z.string().max(200).optional().nullable(),
            building: z.string().max(50).optional().nullable(),
            apartment: z.string().max(50).optional().nullable(),
            zip: z.string().max(30).optional().nullable(),
            postalCode: z.string().max(30).optional().nullable(),
            notes: z.string().max(500).optional().nullable(),
          })
          .optional()
          .nullable(),
      })
      .refine(
        (b) =>
          b.shippingAddressId ||
          b.billingAddressId ||
          Object.prototype.hasOwnProperty.call(b, "shippingAddress") ||
          Object.prototype.hasOwnProperty.call(b, "billingAddress"),
        { message: "At least one address field is required" },
      ),
  });
