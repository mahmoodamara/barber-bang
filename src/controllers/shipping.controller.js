// src/controllers/shipping.controller.js
import { listShippingMethodsPublic } from "../services/shipping.service.js";

export async function listPublic(req, res) {
  const q = req.validated?.query || req.query || {};
  const payableSubtotalMinor = q.payableSubtotalMinor ?? q.payableSubtotal ?? 0;
  const methods = await listShippingMethodsPublic({
    lang: req.lang,
    payableSubtotal: payableSubtotalMinor,
    city: q.city || "",
  });

  // caching خفيف (مناسب للـ public list)
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return res.status(200).json({ ok: true, items: methods });
}
