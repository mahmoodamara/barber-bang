// src/validators/auditLog.validators.js
import { z } from "zod";
import { objectId } from "./common.validators.js";

/**
 * Audit logs query validator
 * Goals:
 * - Safe pagination
 * - Strong filters (actorId, targetId, action, resource, outcome, severity, status)
 * - Optional date range with clamping
 * - No unbounded/expensive queries
 */

const dateStr = z.string().datetime();

const boolFromQuery = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
  });

const outcomeEnum = z.enum(["success", "failure"]).optional();
const statusEnum = z.enum(["success", "fail"]).optional();
const severityEnum = z.enum(["info", "warn", "error", "critical"]).optional();
const actorTypeEnum = z.enum(["user", "admin", "system", "webhook", "anonymous"]).optional();

// These are generic; adapt to your naming conventions if you have enums
const actionSchema = z.string().trim().max(80).optional();     // e.g. "coupon.create"
const resourceSchema = z.string().trim().max(80).optional();   // e.g. "Coupon"
const eventSchema = z.string().trim().max(120).optional();     // e.g. "ADMIN_COUPON_CREATE"
const entityTypeSchema = z.string().trim().max(80).optional(); // e.g. "Coupon", "Order"

const querySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),

    // time window (optional)
    from: dateStr.optional(),
    to: dateStr.optional(),

    // common filters
    actorId: objectId.optional(),
    targetId: objectId.optional(),
    entityId: objectId.optional(),

    // entity/resource type filter
    entityType: entityTypeSchema,
    resource: resourceSchema,

    // semantic filters (optional)
    action: actionSchema,
    event: eventSchema,
    outcome: outcomeEnum,
    status: statusEnum,

    // severity filter
    severity: severityEnum,

    // actor type filter
    actorType: actorTypeEnum,

    // quick text search (if you index it)
    q: z.string().trim().max(120).optional(),

    // include system/internal logs (optional)
    includeSystem: boolFromQuery.optional(),
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

      // clamp range to protect DB (default 90 days)
      const maxRangeDays = 90;
      const maxMs = maxRangeDays * 24 * 60 * 60 * 1000;
      if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs - fromMs > maxMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["to"],
          message: "DATE_RANGE_TOO_LARGE",
        });
      }
    }
  });

// Wrapper for backwards compatibility with validate() middleware
export const adminListAuditLogsQuerySchema = z.object({
  query: querySchema,
});

// Direct schema export for controllers that use req.query directly
export { querySchema as auditLogsQuerySchema };
