// src/validators/featureFlags.validators.js
import { z } from "zod";
import { objectId } from "./common.validators.js";

/**
 * Feature flags validators (aligned with FeatureFlag model + controller)
 * Model fields:
 * - key: string
 * - enabled: boolean
 * - rolesAllow: string[]
 * - allowUserIds: ObjectId[]
 * - rollout: number (0..100)
 * - description: string
 */

const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((v) => v.toLowerCase())
  .refine((v) => /^[a-z0-9][a-z0-9._:-]*$/.test(v), "Invalid feature flag key");

const boolFromQuery = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(s)) return true;
    if (["0", "false", "no", "n", "off"].includes(s)) return false;
    return undefined;
  });

export const adminListFeatureFlagsSchema = z.object({
  query: z.object({
    q: z.string().trim().max(80).optional(),
    enabled: boolFromQuery.optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  }),
});

export const adminUpsertFeatureFlagSchema = z.object({
  params: z.object({
    key: keySchema,
  }),
  body: z
    .object({
      enabled: z.boolean().optional(),
      rollout: z.number().finite().min(0).max(100).optional(),
      description: z.string().trim().max(300).optional(),

      rolesAllow: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
      allowUserIds: z.array(objectId).max(200).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, "Empty body is not allowed"),
});

export const adminDeleteFeatureFlagSchema = z.object({
  params: z.object({
    key: keySchema,
  }),
});
