// src/validators/shippingMode.validators.js
import { z } from "zod";

// Shipping mode enum
export const SHIPPING_MODES = {
  DELIVERY: "DELIVERY",
  PICKUP_POINT: "PICKUP_POINT",
  STORE_PICKUP: "STORE_PICKUP",
};

export const ShippingModeEnum = z.enum([
  SHIPPING_MODES.DELIVERY,
  SHIPPING_MODES.PICKUP_POINT,
  SHIPPING_MODES.STORE_PICKUP,
]);

// MongoDB ObjectId pattern
const objectIdPattern = /^[a-fA-F0-9]{24}$/;
const objectIdSchema = z.string().regex(objectIdPattern, "Invalid ObjectId format");

// Address schema for DELIVERY mode
const addressSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(1).max(30),
  city: z.string().trim().min(1).max(120),
  street: z.string().trim().min(1).max(200),
  building: z.string().trim().max(50).optional().default(""),
  apartment: z.string().trim().max(50).optional().default(""),
  zip: z.string().trim().max(30).optional().default(""),
  notes: z.string().trim().max(500).optional().default(""),
});

// Schema for setting shipping mode on checkout
export const setShippingModeSchema = z
  .object({
    body: z
      .object({
        mode: ShippingModeEnum,
        areaId: objectIdSchema.optional(),
        pickupPointId: objectIdSchema.optional(),
        address: addressSchema.optional(),
      })
      .strict()
      .superRefine((data, ctx) => {
        const { mode, areaId, pickupPointId, address } = data;

        // DELIVERY requires areaId and address
        if (mode === SHIPPING_MODES.DELIVERY) {
          if (!areaId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "areaId is required for DELIVERY mode",
              path: ["areaId"],
            });
          }
          if (!address) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "address is required for DELIVERY mode",
              path: ["address"],
            });
          }
        }

        // PICKUP_POINT requires areaId and pickupPointId
        if (mode === SHIPPING_MODES.PICKUP_POINT) {
          if (!areaId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "areaId is required for PICKUP_POINT mode",
              path: ["areaId"],
            });
          }
          if (!pickupPointId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "pickupPointId is required for PICKUP_POINT mode",
              path: ["pickupPointId"],
            });
          }
        }

        // STORE_PICKUP should NOT have areaId, pickupPointId, or address
        if (mode === SHIPPING_MODES.STORE_PICKUP) {
          if (areaId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "areaId must not be provided for STORE_PICKUP mode",
              path: ["areaId"],
            });
          }
          if (pickupPointId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "pickupPointId must not be provided for STORE_PICKUP mode",
              path: ["pickupPointId"],
            });
          }
          if (address) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "address must not be provided for STORE_PICKUP mode",
              path: ["address"],
            });
          }
        }
      }),
  })
  .strict();

// Admin: Create/Update DeliveryArea
export const createDeliveryAreaSchema = z
  .object({
    body: z
      .object({
        nameHe: z.string().trim().min(1).max(120),
        nameAr: z.string().trim().min(1).max(120),
        code: z.string().trim().toUpperCase().min(1).max(50),
        deliveryEnabled: z.boolean().optional().default(true),
        deliveryPriceMinor: z.number().int().min(0).optional().default(0),
        pickupPointsEnabled: z.boolean().optional().default(true),
        freeDeliveryAboveMinor: z.number().int().min(0).nullable().optional().default(null),
        minSubtotalMinor: z.number().int().min(0).nullable().optional().default(null),
        sort: z.number().int().optional().default(100),
        isActive: z.boolean().optional().default(true),
      })
      .strict(),
  })
  .strict();

export const updateDeliveryAreaSchema = z
  .object({
    body: z
      .object({
        nameHe: z.string().trim().min(1).max(120).optional(),
        nameAr: z.string().trim().min(1).max(120).optional(),
        code: z.string().trim().toUpperCase().min(1).max(50).optional(),
        deliveryEnabled: z.boolean().optional(),
        deliveryPriceMinor: z.number().int().min(0).optional(),
        pickupPointsEnabled: z.boolean().optional(),
        freeDeliveryAboveMinor: z.number().int().min(0).nullable().optional(),
        minSubtotalMinor: z.number().int().min(0).nullable().optional(),
        sort: z.number().int().optional(),
        isActive: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

// Admin: Create/Update PickupPoint
export const createPickupPointSchema = z
  .object({
    body: z
      .object({
        areaId: objectIdSchema,
        nameHe: z.string().trim().min(1).max(120),
        nameAr: z.string().trim().min(1).max(120),
        addressHe: z.string().trim().min(1).max(300),
        addressAr: z.string().trim().min(1).max(300),
        notesHe: z.string().trim().max(500).optional().default(""),
        notesAr: z.string().trim().max(500).optional().default(""),
        hoursHe: z.string().trim().max(200).optional().default(""),
        hoursAr: z.string().trim().max(200).optional().default(""),
        feeMinor: z.number().int().min(0).optional().default(0),
        phone: z.string().trim().max(30).optional().default(""),
        coordinates: z
          .object({
            lat: z.number().nullable().optional(),
            lng: z.number().nullable().optional(),
          })
          .optional(),
        sort: z.number().int().optional().default(100),
        isActive: z.boolean().optional().default(true),
      })
      .strict(),
  })
  .strict();

export const updatePickupPointSchema = z
  .object({
    body: z
      .object({
        areaId: objectIdSchema.optional(),
        nameHe: z.string().trim().min(1).max(120).optional(),
        nameAr: z.string().trim().min(1).max(120).optional(),
        addressHe: z.string().trim().min(1).max(300).optional(),
        addressAr: z.string().trim().min(1).max(300).optional(),
        notesHe: z.string().trim().max(500).optional(),
        notesAr: z.string().trim().max(500).optional(),
        hoursHe: z.string().trim().max(200).optional(),
        hoursAr: z.string().trim().max(200).optional(),
        feeMinor: z.number().int().min(0).optional(),
        phone: z.string().trim().max(30).optional(),
        coordinates: z
          .object({
            lat: z.number().nullable().optional(),
            lng: z.number().nullable().optional(),
          })
          .optional(),
        sort: z.number().int().optional(),
        isActive: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

// Admin: Update StorePickupConfig
export const updateStorePickupConfigSchema = z
  .object({
    body: z
      .object({
        nameHe: z.string().trim().min(1).max(120).optional(),
        nameAr: z.string().trim().min(1).max(120).optional(),
        addressHe: z.string().trim().max(300).optional(),
        addressAr: z.string().trim().max(300).optional(),
        hoursHe: z.string().trim().max(200).optional(),
        hoursAr: z.string().trim().max(200).optional(),
        notesHe: z.string().trim().max(500).optional(),
        notesAr: z.string().trim().max(500).optional(),
        phone: z.string().trim().max(30).optional(),
        coordinates: z
          .object({
            lat: z.number().nullable().optional(),
            lng: z.number().nullable().optional(),
          })
          .optional(),
        isActive: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
