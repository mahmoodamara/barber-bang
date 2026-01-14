// src/validators/readModels.validators.js
import { z } from "zod";

/**
 * Read models validators
 * Routes:
 *   GET /api/v1/admin/read-models
 *   GET /api/v1/admin/read-models/:key?from=...&to=...&page=...&limit=...
 */

const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((v) => v.toLowerCase())
  .refine((v) => /^[a-z0-9][a-z0-9._:-]*$/.test(v), "Invalid read model key");

const dateStr = z.string().datetime();

const sortDir = z.enum(["asc", "desc"]).optional().default("desc");

export const adminReadModelQuerySchema = z.object({
  params: z.object({
    key: keySchema,
  }),
  query: z
    .object({
      from: dateStr.optional(),
      to: dateStr.optional(),

      groupBy: z.enum(["hour", "day", "week", "month"]).optional(),

      sortBy: z.string().trim().max(60).optional(),
      sortDir,

      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),

      q: z.string().trim().max(120).optional(),
      type: z.string().trim().max(60).optional(),
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
        }

        const maxRangeDays = 366;
        const maxMs = maxRangeDays * 24 * 60 * 60 * 1000;
        if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs - fromMs > maxMs) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["to"],
            message: "DATE_RANGE_TOO_LARGE",
          });
        }
      }
    }),
});

export const adminListReadModelsQuerySchema = z.object({
  query: z.object({
    q: z.string().trim().max(120).optional(),
    type: z.string().trim().max(60).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  }),
});
