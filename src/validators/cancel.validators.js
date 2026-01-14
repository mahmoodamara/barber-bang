import { z } from "zod";

export const cancelOrderSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      reason: z.string().max(300).optional(),
    })
    .optional(),
});
