import { z } from "zod";
import { objectId } from "./common.validators.js";

const trimmed = (min, max) => z.string().trim().min(min).max(max);

const returnStatus = z.enum([
  "requested",
  "approved",
  "rejected",
  "received",
  "refunded",
  "exchanged",
  "canceled",
]);

const returnAction = z.enum(["refund", "exchange"]);

const photoUrl = z.string().trim().url().max(500);

export const createReturnRequestSchema = z
  .object({
    body: z
      .object({
        orderId: objectId,
        items: z
          .array(
            z.object({
              orderItemId: objectId,
              variantId: objectId,
              quantity: z.number().int().positive().max(100_000, "quantity too large"),
              action: returnAction,
              reasonCode: trimmed(1, 80),
              reasonText: trimmed(0, 500).optional().nullable(),
              condition: trimmed(0, 80).optional().nullable(),
              photos: z.array(photoUrl).max(12).optional(),
            }),
          )
          .min(1)
          .max(100),

        customerNote: trimmed(0, 1000).optional(),

        exchange: z
          .object({
            items: z
              .array(
                z.object({
                  variantId: objectId,
                  quantity: z.number().int().positive().max(100_000, "quantity too large"),
                }),
              )
              .min(1)
              .max(100),
            priceDiffMinor: z.number().int().min(0).optional().nullable(),
          })
          .optional(),
      })
      .strict(),
  })
  .superRefine((val, ctx) => {
    const items = val?.body?.items || [];

    // Unique orderItemId within request
    const set = new Set();
    for (let i = 0; i < items.length; i += 1) {
      const id = String(items[i]?.orderItemId || "");
      if (set.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body", "items", i, "orderItemId"],
          message: "DUPLICATE_ORDER_ITEM",
        });
      }
      set.add(id);
    }

    const anyExchange = items.some((it) => it?.action === "exchange");
    const exItems = val?.body?.exchange?.items || [];
    if (anyExchange && !exItems.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body", "exchange"],
        message: "EXCHANGE_ITEMS_REQUIRED",
      });
    }
  });

export const listMyReturnsQuerySchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      status: returnStatus.optional(),
    })
    .strict(),
});

export const returnIdParamsSchema = z.object({
  params: z.object({ id: objectId }).strict(),
});

export const cancelReturnParamsSchema = z.object({
  params: z.object({ id: objectId }).strict(),
  body: z.object({}).optional(),
});

export const adminListReturnsQuerySchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(200).optional().default(20),
      q: z.string().trim().max(120).optional(),
      status: returnStatus.optional(),
      userId: objectId.optional(),
      orderId: objectId.optional(),
      sort: z
        .string()
        .trim()
        .max(60)
        .regex(/^-?(createdAt|status|requestedAt|decidedAt|receivedAt|closedAt)$/)
        .optional(),
    })
    .strict(),
});

export const adminReturnIdParamsSchema = returnIdParamsSchema;

export const adminDecisionSchema = z.object({
  params: z.object({ id: objectId }).strict(),
  body: z
    .object({
      decision: z.enum(["approve", "reject"]),
      note: trimmed(0, 2000).optional().nullable(),
    })
    .strict(),
});

export const adminMarkReceivedSchema = z.object({
  params: z.object({ id: objectId }).strict(),
  body: z
    .object({
      note: trimmed(0, 2000).optional().nullable(),
    })
    .strict(),
});

export const adminCloseSchema = z.object({
  params: z.object({ id: objectId }).strict(),
  body: z
    .object({
      status: z.enum(["refunded", "exchanged", "canceled"]),
      note: trimmed(0, 2000).optional().nullable(),
    })
    .strict(),
});

