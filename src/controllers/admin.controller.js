// src/controllers/admin.controller.js

/**
 * admin.controller.js — Hardened (RBAC-ready + response-envelope consistent)
 *
 * Key fixes vs previous:
 * - Uses req.requestId (NOT req.id) for audit context
 * - Uses statusCode (NOT status) on thrown errors to match centralized errorHandler
 * - Returns consistent success envelope: { ok: true, data: ... }
 * - Keeps defensive ObjectId parsing, boolean parsing, and DTO shaping
 * - Keeps services thick: controller remains thin
 *
 * Assumptions:
 * - validate(...) puts payload under req.validated.body
 * - requireAuth sets req.auth.userId and req.auth.roles
 * - requestId middleware sets req.requestId
 */

import mongoose from "mongoose";

import {
  createCategory as createCategorySvc,
  updateCategory as updateCategorySvc,
  softDeleteCategory as softDeleteCategorySvc,
  listCategoriesAdmin as listCategoriesAdminSvc,
} from "../services/category.service.js";

import {
  createProduct as createProductSvc,
  updateProduct as updateProductSvc,
  softDeleteProduct as softDeleteProductSvc,
} from "../services/product.service.js";

import {
  createVariant as createVariantSvc,
  updateVariant as updateVariantSvc,
  softDeleteVariant as softDeleteVariantSvc,
  adjustVariantStock as adjustVariantStockSvc,
} from "../services/variant.service.js";

import { mapMoneyPairFromMinor, normalizeCurrency } from "../utils/money.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";

// --------------------
// Helpers
// --------------------
function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function requireObjectId(id, code = "INVALID_ID") {
  const v = String(id || "");
  if (!isValidObjectId(v)) {
    throw httpError(400, code, code);
  }
  return v;
}

function parseBool(val, defaultValue) {
  if (val === undefined || val === null) return defaultValue;
  const s = String(val).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
}

function toIdDTO(docOrPlain) {
  if (!docOrPlain) return docOrPlain;

  const obj =
    typeof docOrPlain?.toObject === "function"
      ? docOrPlain.toObject({ virtuals: false })
      : docOrPlain;

  const { _id, ...rest } = obj;
  return { ...rest, id: String(_id) };
}

function toIdDTOList(items) {
  return Array.isArray(items) ? items.map(toIdDTO) : [];
}

function toVariantDTO(docOrPlain) {
  const v = toIdDTO(docOrPlain);
  if (!v) return v;
  const currency = normalizeCurrency(v.currency);
  if (v.price !== undefined) {
    return {
      ...v,
      ...mapMoneyPairFromMinor(v.price, currency, "price", "priceMinor"),
      currency,
    };
  }
  return { ...v, currency };
}

function actorCtx(req) {
  return {
    actorId: req.auth?.userId || null,
    requestId: req.requestId || null, // ✅ FIX: was req.id
    ip: req.ip || null,
    roles: req.auth?.roles || [],
  };
}

// Success helper (consistent envelope)
function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

// --------------------
// Category
// --------------------
export async function adminListCategories(req, res) {
  const parentId = req.query.parentId
    ? requireObjectId(req.query.parentId, "INVALID_PARENT_ID")
    : null;

  const includeInactive = parseBool(req.query.includeInactive, true);

  const items = await listCategoriesAdminSvc({
    parentId,
    includeInactive,
    ctx: actorCtx(req),
  });

  return ok(res, { items: toIdDTOList(items) });
}

export async function createCategory(req, res) {
  try {
    const cat = await createCategorySvc(req.validated.body, { ctx: actorCtx(req) });
    await logAuditSuccess(req, AuditActions.ADMIN_CATEGORY_CREATE, { type: "Category", id: String(cat._id) });
    return ok(res, { category: toIdDTO(cat) }, 201);
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_CATEGORY_CREATE, { type: "Category" }, err);
    throw err;
  }
}

export async function updateCategory(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_CATEGORY_ID");
  try {
    const cat = await updateCategorySvc(id, req.validated.body, { ctx: actorCtx(req) });
    await logAuditSuccess(req, AuditActions.ADMIN_CATEGORY_UPDATE, { type: "Category", id });
    return ok(res, { category: toIdDTO(cat) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_CATEGORY_UPDATE, { type: "Category", id }, err);
    throw err;
  }
}

export async function softDeleteCategory(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_CATEGORY_ID");
  try {
    const cat = await softDeleteCategorySvc(id, { ctx: actorCtx(req) });
    await logAuditSuccess(req, AuditActions.ADMIN_CATEGORY_DELETE, { type: "Category", id });
    return ok(res, { category: toIdDTO(cat) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_CATEGORY_DELETE, { type: "Category", id }, err);
    throw err;
  }
}

// --------------------
// Product
// --------------------
export async function createProduct(req, res) {
  try {
    const prod = await createProductSvc(req.validated.body, { ctx: actorCtx(req) });
    await logAuditSuccess(req, AuditActions.ADMIN_PRODUCT_CREATE, { type: "Product", id: String(prod._id) });
    return ok(res, { product: toIdDTO(prod) }, 201);
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_PRODUCT_CREATE, { type: "Product" }, err);
    throw err;
  }
}

export async function updateProduct(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_PRODUCT_ID");
  try {
    const prod = await updateProductSvc(id, req.validated.body, { ctx: actorCtx(req) });
    await logAuditSuccess(req, AuditActions.ADMIN_PRODUCT_UPDATE, { type: "Product", id });
    return ok(res, { product: toIdDTO(prod) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_PRODUCT_UPDATE, { type: "Product", id }, err);
    throw err;
  }
}

export async function softDeleteProduct(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_PRODUCT_ID");
  try {
    const prod = await softDeleteProductSvc(id, { ctx: actorCtx(req) });
    await logAuditSuccess(req, AuditActions.ADMIN_PRODUCT_DELETE, { type: "Product", id });
    return ok(res, { product: toIdDTO(prod) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_PRODUCT_DELETE, { type: "Product", id }, err);
    throw err;
  }
}

// --------------------
// Variant
// --------------------
export async function createVariant(req, res) {
  const productId = requireObjectId(req.params.productId, "INVALID_PRODUCT_ID");
  try {
    const v = await createVariantSvc(productId, req.validated.body, { ctx: actorCtx(req) });
    await logAuditSuccess(req, AuditActions.ADMIN_VARIANT_CREATE, { type: "Variant", id: String(v._id) });
    return ok(res, { variant: toVariantDTO(v) }, 201);
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_VARIANT_CREATE, { type: "Variant" }, err);
    throw err;
  }
}

export async function updateVariant(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_VARIANT_ID");
  try {
    const v = await updateVariantSvc(id, req.validated.body, { ctx: actorCtx(req) });
    await logAuditSuccess(req, AuditActions.ADMIN_VARIANT_UPDATE, { type: "Variant", id });
    return ok(res, { variant: toVariantDTO(v) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_VARIANT_UPDATE, { type: "Variant", id }, err);
    throw err;
  }
}

export async function softDeleteVariant(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_VARIANT_ID");
  try {
    const v = await softDeleteVariantSvc(id, { ctx: actorCtx(req) });
    await logAuditSuccess(req, AuditActions.ADMIN_VARIANT_DELETE, { type: "Variant", id });
    return ok(res, { variant: toVariantDTO(v) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_VARIANT_DELETE, { type: "Variant", id }, err);
    throw err;
  }
}

export async function adjustVariantStock(req, res) {
  const variantId = requireObjectId(req.params.id, "INVALID_VARIANT_ID");

  // body already validated, keep defensive normalization
  const delta = Number(req.validated.body.delta);
  if (!Number.isFinite(delta) || delta === 0) {
    throw httpError(422, "INVALID_DELTA", "delta must be a non-zero number");
  }

  const reason = String(req.validated.body.reason || "").trim();

  try {
    const v = await adjustVariantStockSvc({
      variantId,
      delta,
      reason,
      actorId: req.auth?.userId, // backwards compatibility if service expects it
      ctx: actorCtx(req),
    });

    await logAuditSuccess(req, AuditActions.ADMIN_VARIANT_STOCK_ADJUST, {
      type: "Variant",
      id: variantId,
    }, { message: `Stock adjusted by ${delta}: ${reason}` });

    return ok(res, { variant: toVariantDTO(v) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_VARIANT_STOCK_ADJUST, { type: "Variant", id: variantId }, err);
    throw err;
  }
}
