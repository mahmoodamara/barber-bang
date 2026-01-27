// src/routes/offers.routes.js
import express from "express";

import { Offer } from "../models/Offer.js";
import { t } from "../utils/i18n.js";

const router = express.Router();

/**
 * GET /api/offers/active?lang=he|ar
 * Returns unified "name" + type/value/startAt/endAt/minTotal
 * Only active offers within date range.
 */

function mapOffer(o, lang) {
  return {
    id: o._id,
    _id: o._id, // additive compatibility

    type: o.type,

    nameHe: o.nameHe || o.name || "",
    nameAr: o.nameAr || "",
    name: t(o, "name", lang),

    value: Number(o.value || 0),
    minTotal: Number(o.minTotal || 0),

    startAt: o.startAt || null,
    endAt: o.endAt || null,
  };
}

router.get("/active", async (req, res, next) => {
  try {
    const now = new Date();

    const items = await Offer.find({
      isActive: true,
      $and: [
        { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
        { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
      ],
    })
      .sort({ priority: 1, createdAt: -1 })
      .limit(50)
      .lean();

    const data = items.map((o) => mapOffer(o, req.lang));
    return res.json({ ok: true, data });
  } catch (e) {
    return next(e);
  }
});

export default router;
