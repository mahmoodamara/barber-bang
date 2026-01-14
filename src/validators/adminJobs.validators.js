import { z } from "zod";

import { objectId } from "./common.validators.js";

const jobStatus = z
  .string()
  .trim()
  .transform((v) => (v === "done" ? "succeeded" : v))
  .pipe(z.enum(["pending", "processing", "succeeded", "failed"]));

const sortEnum = z
  .string()
  .trim()
  .max(60)
  .regex(/^-?(createdAt|status|updatedAt|attempts)$/);

export const adminListJobsQuerySchema = z
  .object({
    query: z
      .object({
        page: z.coerce.number().int().min(1).optional().default(1),
        limit: z.coerce.number().int().min(1).max(100).optional().default(20),
        status: jobStatus.optional(),
        type: z.string().trim().max(80).optional(),
        q: z.string().trim().max(120).optional(),
        sort: sortEnum.optional(),
      }),
  });

export const adminJobIdParamsSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
  });

export const adminRetryJobSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
    body: z.object({}).strict().default({}),
  });

export const adminRetryFailedJobsSchema = z
  .object({
    body: z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      })
      .strict()
      .default({}),
  });
