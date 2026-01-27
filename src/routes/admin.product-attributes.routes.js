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

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function jsonErr(res, e) {
  return sendError(
    res,
    e?.statusCode || 500,
    e?.code || "INTERNAL_ERROR",
    e?.message || "Unexpected error"
  );
}

function safeNotFound(res, message = "Not found") {
  return sendError(res, 404, "NOT_FOUND", message);
}

const snakeKey = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9_]+$/, "key must be snake_case");

const optionSchema = z.object({
  valueKey: snakeKey,
  labelHe: z.string().max(120).optional(),
  labelAr: z.string().max(120).optional(),
  isActive: z.boolean().optional(),
});

const baseSchema = z
  .object({
    key: snakeKey.optional(),
    nameHe: z.string().max(120).optional(),
    nameAr: z.string().max(120).optional(),
    type: z.enum(["text", "number", "enum"]).optional(),
    unit: z.string().max(20).optional(),
    options: z.array(optionSchema).max(200).optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.type === "enum") {
      if (!Array.isArray(b.options) || b.options.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: "options are required for enum attributes",
        });
      }
    }
  });

const createSchema = z.object({
  body: z
    .object({
      key: snakeKey,
      nameHe: z.string().max(120).optional(),
      nameAr: z.string().max(120).optional(),
      type: z.enum(["text", "number", "enum"]),
      unit: z.string().max(20).optional(),
      options: z.array(optionSchema).max(200).optional(),
      isActive: z.boolean().optional(),
    })
    .superRefine((b, ctx) => {
      if (b.type === "enum") {
        if (!Array.isArray(b.options) || b.options.length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["options"],
            message: "options are required for enum attributes",
          });
        }
      }
    }),
});
const updateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: baseSchema,
});

function sanitizePatch(b) {
  const out = { ...b };
  for (const k of ["key", "nameHe", "nameAr", "unit"]) {
    if (typeof out[k] === "string") out[k] = out[k].trim();
  }
  if (Array.isArray(out.options)) {
    out.options = out.options.map((o) => ({
      ...o,
      valueKey: typeof o.valueKey === "string" ? o.valueKey.trim() : o.valueKey,
      labelHe: typeof o.labelHe === "string" ? o.labelHe.trim() : o.labelHe,
      labelAr: typeof o.labelAr === "string" ? o.labelAr.trim() : o.labelAr,
    }));
  }
  return out;
}

router.get("/", async (_req, res) => {
  try {
    const items = await ProductAttribute.find().sort({ key: 1 });
    return sendOk(res, items);
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.post("/", validate(createSchema), async (req, res) => {
  try {
    const b = sanitizePatch(req.validated.body);
    const item = await ProductAttribute.create({
      key: b.key,
      nameHe: b.nameHe || "",
      nameAr: b.nameAr || "",
      type: b.type,
      unit: b.unit || "",
      options: b.options || [],
      isActive: b.isActive ?? true,
    });
    return sendCreated(res, item);
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.put("/:id", validate(updateSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid ProductAttribute id");

    const before = await ProductAttribute.findById(id);
    if (!before) return safeNotFound(res, "ProductAttribute not found");
    res.locals.auditBefore = before.toObject();

    const patch = sanitizePatch(req.validated.body);
    const item = await ProductAttribute.findByIdAndUpdate(id, patch, {
      new: true,
      runValidators: true,
    });
    if (!item) return safeNotFound(res, "ProductAttribute not found");
    return sendOk(res, item);
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid ProductAttribute id");

    const before = await ProductAttribute.findById(id);
    if (!before) return safeNotFound(res, "ProductAttribute not found");
    res.locals.auditBefore = before.toObject();

    await ProductAttribute.updateOne({ _id: id }, { $set: { isActive: false } });
    return sendOk(res, { deleted: true });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
