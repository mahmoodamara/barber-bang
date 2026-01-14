// src/validators/adminAuditLog.validators.js
import { z } from "zod";
import {
  objectId,
  paginationQuery,
  sortingQuery,
  dateRangeQuery,
  boolFromQuery,
  searchQuery,
} from "./common.validators.js";

/**
 * Admin Audit Logs - query schema
 * Intended usage:
 *   validate(adminListAuditLogsSchema)
 * where your validate wrapper provides req.validated.query
 */

const outcomeEnum = z.enum(["success", "failure"]).optional();

const actionSchema = z
  .string()
  .trim()
  .max(80)
  .optional(); // e.g. "orders.refund", "catalog.write"

const entityTypeSchema = z
  .string()
  .trim()
  .max(80)
  .optional(); // e.g. "Order", "Coupon", "Product"

export const adminListAuditLogsSchema = z.object({
  query: paginationQuery
    .merge(sortingQuery) // optional; if your service ignores sortingQuery it's fine
    .merge(dateRangeQuery({ maxRangeDays: 90 }))
    .merge(searchQuery)
    .extend({
      // filters
      action: actionSchema,
      entityType: entityTypeSchema,

      entityId: objectId.optional(),
      actorId: objectId.optional(),

      outcome: outcomeEnum,

      // show logs with actorId=null (system/internal)
      includeSystem: boolFromQuery.optional(),
    })
    .superRefine((q, ctx) => {
      // Optional sanity: disallow very broad queries when no filters + large limit
      // (Keeps DB safe even if someone tries to scan everything)
      const hasAnyFilter =
        Boolean(q.q) ||
        Boolean(q.from) ||
        Boolean(q.to) ||
        Boolean(q.action) ||
        Boolean(q.entityType) ||
        Boolean(q.entityId) ||
        Boolean(q.actorId) ||
        Boolean(q.outcome);

      if (!hasAnyFilter && (q.limit || 50) > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["limit"],
          message: "LIMIT_TOO_HIGH_WITHOUT_FILTERS",
        });
      }
    }),
});
