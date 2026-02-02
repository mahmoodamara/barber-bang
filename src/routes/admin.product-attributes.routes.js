// src/routes/admin.product-attributes.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { sendOk, sendCreated, sendError } from "../utils/response.js";
import { validate } from "../middleware/validate.js";
import { createLimiter } from "../middleware/rateLimit.js";
import { ProductAttribute } from "../models/ProductAttribute.js";
import { getRequestId } from "../middleware/error.js";

const router = express.Router();

/**
 * Gate + protections:
 * - Auth
 * - PRODUCTS_WRITE
 * - Rate limit to protect admin endpoints from UI loops/spam
 * - Audit all changes
 */
router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.PRODUCTS_WRITE));
router.use(
  createLimiter({
    windowMs: 60_000,
    limit: 60,
    messageText: "Too many admin requests. Please slow down.",
  })
);
router.use(auditAdmin());

/* =========================
   Helpers
========================= */

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function makeErr(statusCode, code, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function jsonErr(req, res, e) {
  return sendError(
    res,
    e?.statusCode || 500,
    e?.code || "INTERNAL_ERROR",
    e?.message || "Unexpected error",
    {
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
    }
  );
}

function safeNotFound(req, res, message = "Not found") {
  return sendError(res, 404, "NOT_FOUND", message, {
    requestId: getRequestId(req),
    path: req.originalUrl || req.url || "",
  });
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Normalize snake_case key:
 * - trim
 * - lowercase
 */
function normalizeKey(key) {
  return String(key || "").trim().toLowerCase();
}

/**
 * Deduplicate options by valueKey (last write wins),
 * and normalize valueKey/labels.
 */
function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];

  const map = new Map();
  for (const o of options) {
    if (!o) continue;

    const valueKey = normalizeKey(o.valueKey);
    if (!valueKey) continue;

    map.set(valueKey, {
      valueKey,
      labelHe: typeof o.labelHe === "string" ? o.labelHe.trim().slice(0, 120) : "",
      labelAr: typeof o.labelAr === "string" ? o.labelAr.trim().slice(0, 120) : "",
      isActive: typeof o.isActive === "boolean" ? o.isActive : true,
    });
  }

  return Array.from(map.values()).slice(0, 200);
}

/**
 * Sanitize patch payload:
 * - trims strings
 * - normalizes key/valueKey to lower snake_case
 * - normalizes options
 */
function sanitizePatch(b) {
  const out = { ...(b || {}) };

  if (typeof out.key === "string") out.key = normalizeKey(out.key);
  if (typeof out.nameHe === "string") out.nameHe = out.nameHe.trim().slice(0, 120);
  if (typeof out.nameAr === "string") out.nameAr = out.nameAr.trim().slice(0, 120);
  if (typeof out.unit === "string") out.unit = out.unit.trim().slice(0, 20);

  if (Array.isArray(out.options)) out.options = normalizeOptions(out.options);

  return out;
}

/**
 * Ensure "enum" has options (after normalization), and forbid options for non-enum by default.
 * (You can relax this if you want to allow storing options regardless of type.)
 */
function validateTypeOptionsInvariant(type, options, ctx, path = ["options"]) {
  if (type === "enum") {
    if (!Array.isArray(options) || options.length === 0) {
      ctx.addIssue({
        code: "custom",
        path,
        message: "options are required for enum attributes",
      });
    }
  }
}

/* =========================
   Zod Schemas
========================= */

const snakeKey = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9_]+$/, "key must be snake_case");

const optionSchema = z
  .object({
    valueKey: snakeKey,
    labelHe: z.string().max(120).optional(),
    labelAr: z.string().max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const typeEnum = z.enum(["text", "number", "enum"]);

/**
 * Query for listing: allow filtering + simple search.
 * NOTE: Strict allowlist.
 */
const listSchema = z.object({
  query: z
    .object({
      isActive: z.enum(["true", "false"]).optional(),
      q: z.string().max(120).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
    })
    .strict()
    .optional(),
});

/**
 * Create schema: strict body.
 * Key is required on create.
 */
const createSchema = z.object({
  body: z
    .object({
      key: snakeKey,
      nameHe: z.string().max(120).optional(),
      nameAr: z.string().max(120).optional(),
      type: typeEnum,
      unit: z.string().max(20).optional(),
      options: z.array(optionSchema).max(200).optional(),
      isActive: z.boolean().optional(),
    })
    .strict()
    .superRefine((b, ctx) => {
      if (b.type === "enum") {
        validateTypeOptionsInvariant(b.type, b.options, ctx);
      }
    }),
});

/**
 * Update schema: strict body, patch-style but:
 * - key is NOT allowed to change (to avoid breaking product variant bindings)
 */
const updateSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
  body: z
    .object({
      // key intentionally omitted (immutable)
      nameHe: z.string().max(120).optional(),
      nameAr: z.string().max(120).optional(),
      type: typeEnum.optional(),
      unit: z.string().max(20).optional(),
      options: z.array(optionSchema).max(200).optional(),
      isActive: z.boolean().optional(),
    })
    .strict()
    .superRefine(async (b, ctx) => {
      // We can only enforce enum-options relationship if type is set to enum in patch
      // or if options are provided and would imply enum usage.
      if (b.type === "enum") {
        validateTypeOptionsInvariant("enum", b.options, ctx);
      }
    }),
});

/* =========================
   Utilities
========================= */

function clampLimit(v, def = 200, max = 500) {
  const n = Number(v ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

/* =========================
   Routes
========================= */

/**
 * GET /api/v1/admin/product-attributes?isActive=true|false&q=&limit=
 * - Returns catalog of attributes
 * - Optional filter by isActive
 * - Optional search by key/nameHe/nameAr
 */
router.get("/", validate(listSchema), async (req, res) => {
  try {
    const q = req.validated?.query || {};
    const limit = clampLimit(q.limit, 200, 500);

    const filter = {};

    if (q.isActive === "true") filter.isActive = true;
    if (q.isActive === "false") filter.isActive = false;

    if (q.q) {
      const term = String(q.q).trim().slice(0, 120);
      if (term) {
        const rx = new RegExp(escapeRegex(term), "i");
        filter.$or = [{ key: rx }, { nameHe: rx }, { nameAr: rx }];
      }
    }

    const items = await ProductAttribute.find(filter)
      .sort({ key: 1 })
      .limit(limit)
      .lean();

    return sendOk(res, items, { limit });
  } catch (e) {
    return jsonErr(req, res, e);
  }
});

/**
 * POST /api/v1/admin/product-attributes
 * Creates a ProductAttribute
 * - Enforces unique key (best effort + relies on DB unique index if present)
 * - Normalizes key/options
 */
router.post("/", validate(createSchema), async (req, res) => {
  try {
    const b0 = req.validated.body;
    const b = sanitizePatch(b0);

    // Enforce unique key (app-level check; DB unique index still recommended)
    const existing = await ProductAttribute.findOne({ key: b.key }).select("_id key").lean();
    if (existing) {
      throw makeErr(409, "DUPLICATE_KEY", `ProductAttribute key "${b.key}" already exists`);
    }

    // Normalize options for non-enum: store empty unless explicitly desired
    const options = b.type === "enum" ? b.options || [] : [];

    const item = await ProductAttribute.create({
      key: b.key,
      nameHe: b.nameHe || "",
      nameAr: b.nameAr || "",
      type: b.type,
      unit: b.unit || "",
      options,
      isActive: typeof b.isActive === "boolean" ? b.isActive : true,
    });

    return sendCreated(res, item);
  } catch (e) {
    // Handle Mongo duplicate key errors if unique index exists
    if (e?.code === 11000) {
      return sendError(res, 409, "DUPLICATE_KEY", "ProductAttribute key already exists", {
        requestId: getRequestId(req),
        path: req.originalUrl || req.url || "",
      });
    }
    return jsonErr(req, res, e);
  }
});

/**
 * PUT /api/v1/admin/product-attributes/:id
 * Updates ProductAttribute (key is immutable)
 */
router.put("/:id", validate(updateSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid ProductAttribute id");

    const before = await ProductAttribute.findById(id);
    if (!before) return safeNotFound(req, res, "ProductAttribute not found");
    res.locals.auditBefore = before.toObject();

    const patch = sanitizePatch(req.validated.body);

    // If patch sets type to enum, ensure options exist.
    // If patch does NOT set type but sends options, validate against existing type.
    const effectiveType = patch.type || before.type;

    if (effectiveType === "enum") {
      const effectiveOptions = Array.isArray(patch.options) ? patch.options : before.options || [];
      if (!Array.isArray(effectiveOptions) || effectiveOptions.length === 0) {
        throw makeErr(400, "VALIDATION_ERROR", "options are required for enum attributes");
      }
      patch.options = Array.isArray(patch.options) ? patch.options : before.options || [];
    } else {
      // Non-enum: clear options if type becomes non-enum
      if (patch.type && patch.type !== "enum") {
        patch.options = [];
      }
    }

    const item = await ProductAttribute.findByIdAndUpdate(id, patch, {
      new: true,
      runValidators: true,
    }).lean();

    if (!item) return safeNotFound(req, res, "ProductAttribute not found");
    return sendOk(res, item);
  } catch (e) {
    return jsonErr(req, res, e);
  }
});

/**
 * DELETE /api/v1/admin/product-attributes/:id
 * Soft delete by setting isActive=false
 */
router.delete("/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid ProductAttribute id");

    const before = await ProductAttribute.findById(id);
    if (!before) return safeNotFound(req, res, "ProductAttribute not found");
    res.locals.auditBefore = before.toObject();

    await ProductAttribute.updateOne({ _id: id }, { $set: { isActive: false } });
    return sendOk(res, { deleted: true });
  } catch (e) {
    return jsonErr(req, res, e);
  }
});

export default router;
