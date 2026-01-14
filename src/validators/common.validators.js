// src/validators/common.validators.js
import { z } from "zod";

/**
 * Shared validators (world-class baseline)
 * - objectId
 * - pagination
 * - sorting
 * - dateRange (with max-range guard)
 * - boolean parsing from query strings
 */

export const objectId = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, "INVALID_OBJECT_ID");

export const optionalObjectId = objectId.optional();

export const boolFromQuery = z
  .union([z.string(), z.boolean(), z.number()])
  .transform((v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v === 1;
    const s = String(v).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(s)) return true;
    if (["0", "false", "no", "n", "off"].includes(s)) return false;
    return undefined;
  });

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const sortDirQuery = z
  .enum(["asc", "desc"])
  .optional()
  .default("desc");

export const sortingQuery = z.object({
  sortBy: z.string().trim().max(60).optional(),
  sortDir: sortDirQuery,
});

/**
 * ISO date-time string (Zod datetime)
 * Note: expects full ISO format. If you accept date-only, adjust here.
 */
export const isoDateTime = z.string().datetime();

/**
 * Common date range query with clamping
 * - default max range: 90 days
 */
export function dateRangeQuery({ maxRangeDays = 90 } = {}) {
  return z
    .object({
      from: isoDateTime.optional(),
      to: isoDateTime.optional(),
    })
    .superRefine((q, ctx) => {
      if (q.from && q.to) {
        const fromMs = new Date(q.from).getTime();
        const toMs = new Date(q.to).getTime();

        if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs > toMs) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["to"],
            message: "INVALID_DATE_RANGE",
          });
          return;
        }

        const maxMs = Number(maxRangeDays) * 24 * 60 * 60 * 1000;
        if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs - fromMs > maxMs) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["to"],
            message: "DATE_RANGE_TOO_LARGE",
          });
        }
      }
    });
}

/**
 * Small helper for bounded search terms
 */
export const searchQuery = z.object({
  q: z.string().trim().max(120).optional(),
});
