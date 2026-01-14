import { z } from "zod";
import { objectId } from "./_common.js";

export const myOrderFulfillmentParamsSchema = z.object({
  params: z.object({
    id: objectId,
  }),
});

export const adminAddFulfillmentEventSchema = z.object({
  params: z.object({
    id: objectId,
  }),
  body: z.object({
    type: z.string().min(2).max(40),
    at: z.union([z.string().datetime(), z.date()]).optional(),
    note: z.string().max(500).optional().nullable(),
    meta: z.unknown().optional().nullable(),
  }),
});

