import { z } from "zod";

import { objectId } from "./common.validators.js";
import { ORDER_STATUS } from "../utils/orderState.js";

const orderStatusEnum = z
  .string()
  .trim()
  .transform((v) => (v === "canceled" ? "cancelled" : v));

const orderStatus = orderStatusEnum.pipe(z.enum(Object.values(ORDER_STATUS)));

const dateStr = z.string().datetime();

const sortEnum = z
  .string()
  .trim()
  .max(60)
  .regex(/^-?(createdAt|status|total|orderNumber)$/);

export const adminListOrdersQuerySchema = z
  .object({
    query: z
      .object({
        page: z.coerce.number().int().min(1).optional().default(1),
        limit: z.coerce.number().int().min(1).max(100).optional().default(20),
        q: z.string().trim().max(120).optional(),
        status: orderStatus.optional(),
        fromDate: dateStr.optional(),
        toDate: dateStr.optional(),
        sort: sortEnum.optional(),
      })
      .superRefine((q, ctx) => {
        if (q.fromDate && q.toDate) {
          const fromMs = new Date(q.fromDate).getTime();
          const toMs = new Date(q.toDate).getTime();
          if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs > toMs) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["toDate"],
              message: "INVALID_DATE_RANGE",
            });
          }
        }
      }),
  });

export const adminOrderIdParamsSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
  });

export const adminUpdateOrderStatusSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        status: orderStatus,
        reason: z.string().trim().max(300).optional(),
      })
      .strict(),
  });

export const adminUpdateOrderTrackingSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        carrier: z.string().trim().max(80).optional(),
        trackingNumber: z.string().trim().max(120).optional(),
        trackingUrl: z.string().trim().url().max(500).optional(),
      })
      .strict()
      .superRefine((b, ctx) => {
        const hasAny =
          b.carrier !== undefined ||
          b.trackingNumber !== undefined ||
          b.trackingUrl !== undefined;
        if (!hasAny) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [],
            message: "EMPTY_UPDATE",
          });
        }
      }),
  });

export const adminAddOrderNoteSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        note: z.string().trim().min(1).max(500),
      })
      .strict(),
  });

export const adminResolvePaymentSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        action: z.enum(["retry_stock_confirm", "mark_requires_refund", "mark_cod_paid"]),
        note: z.string().trim().max(500).optional(),
      })
      .strict(),
  });

export const adminCodAcceptSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        note: z.string().trim().max(500).optional(),
      })
      .strict(),
  });

export const adminCodRejectSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        reason: z.string().trim().max(300).optional(),
        note: z.string().trim().max(500).optional(),
      })
      .strict(),
  });
