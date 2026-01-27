// src/routes/product-attributes.routes.js
import express from "express";

import { ProductAttribute } from "../models/ProductAttribute.js";
import { getRequestId } from "../middleware/error.js";

const router = express.Router();

function jsonErr(res, e) {
  const req = res.req;
  return res.status(e?.statusCode || 500).json({
    ok: false,
    error: {
      code: e?.code || "INTERNAL_ERROR",
      message: e?.message || "Unexpected error",
      requestId: getRequestId(req),
      path: req?.originalUrl || req?.url || "",
    },
  });
}

function pickName(doc, lang) {
  const L = String(lang || "he").toLowerCase() === "ar" ? "ar" : "he";
  return L === "ar" ? doc?.nameAr || doc?.nameHe || "" : doc?.nameHe || doc?.nameAr || "";
}

function mapOption(o) {
  return {
    valueKey: o?.valueKey || "",
    labelHe: o?.labelHe || "",
    labelAr: o?.labelAr || "",
  };
}

function mapAttribute(a, lang) {
  const options = Array.isArray(a?.options) ? a.options.filter((o) => o?.isActive) : [];
  return {
    id: a._id,
    _id: a._id,
    key: a.key,
    name: pickName(a, lang),
    nameHe: a.nameHe || "",
    nameAr: a.nameAr || "",
    type: a.type,
    unit: a.unit || "",
    options: options.map(mapOption),
  };
}

/**
 * GET /api/v1/product-attributes?lang=he|ar
 * Public, active only.
 */
router.get("/", async (req, res) => {
  try {
    const items = await ProductAttribute.find({ isActive: true }).sort({ key: 1 }).lean();
    return res.json({ ok: true, data: items.map((a) => mapAttribute(a, req.lang)) });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
