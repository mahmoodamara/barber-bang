// src/routes/shipping.routes.js
import express from "express";
import { z } from "zod";

import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { StorePickupConfig } from "../models/StorePickupConfig.js";
import { t } from "../utils/i18n.js";
import { validate } from "../middleware/validate.js";
import { calculateShipping, getShippingConfig } from "../services/shipping.service.js";
import { sendOk, setPrivateNoStore } from "../utils/response.js";

const router = express.Router();

function mapDeliveryArea(a, lang) {
  return {
    id: a._id,
    _id: a._id,

    nameHe: a.nameHe || a.name || "",
    nameAr: a.nameAr || "",
    name: t(a, "name", lang),

    fee: Number(a.fee || 0),
    isActive: Boolean(a.isActive),
  };
}

function mapPickupPoint(p, lang) {
  return {
    id: p._id,
    _id: p._id,

    nameHe: p.nameHe || p.name || "",
    nameAr: p.nameAr || "",
    name: t(p, "name", lang),

    addressHe: p.addressHe || p.address || "",
    addressAr: p.addressAr || "",
    address: t(p, "address", lang),

    fee: Number(p.fee || 0),
    isActive: Boolean(p.isActive),
  };
}

function mapStorePickup(storeCfg, lang) {
  // ✅ If config not found, disable by default
  if (!storeCfg) {
    return {
      isEnabled: false,
      fee: 0,
      address: "",
      notes: "",
    };
  }

  return {
    id: storeCfg._id,
    _id: storeCfg._id,

    isEnabled: Boolean(storeCfg.isEnabled),
    fee: Number(storeCfg.fee || 0),

    addressHe: storeCfg.addressHe || storeCfg.address || "",
    addressAr: storeCfg.addressAr || "",
    address: t(storeCfg, "address", lang),

    notesHe: storeCfg.notesHe || storeCfg.notes || "",
    notesAr: storeCfg.notesAr || "",
    notes: t(storeCfg, "notes", lang),
  };
}

/**
 * GET /api/shipping/options?lang=he|ar
 * Returns:
 * {
 *   deliveryAreas: [...],
 *   pickupPoints: [...],
 *   storePickup: {...}
 * }
 */
router.get("/options", async (req, res, next) => {
  try {
    const [areas, points, storeCfg] = await Promise.all([
      DeliveryArea.find({ isActive: true }).sort({ createdAt: -1 }).lean(),
      PickupPoint.find({ isActive: true }).sort({ createdAt: -1 }).lean(),
      StorePickupConfig.findOne().sort({ createdAt: -1 }).lean(),
    ]);

    return res.json({
      ok: true,
      data: {
        deliveryAreas: areas.map((a) => mapDeliveryArea(a, req.lang)),
        pickupPoints: points.map((p) => mapPickupPoint(p, req.lang)),
        storePickup: mapStorePickup(storeCfg, req.lang),
      },
    });
  } catch (e) {
    return next(e);
  }
});

/**
 * GET /api/shipping/config
 * Public read-only shipping config for UI display (banner/threshold text).
 */
router.get("/config", async (req, res, next) => {
  try {
    setPrivateNoStore(res);
    const config = await getShippingConfig();
    return sendOk(res, {
      freeShippingThreshold: {
        retail: Number(config?.freeShippingThreshold?.retail || 0),
        wholesale: Number(config?.freeShippingThreshold?.wholesale || 0),
      },
      baseShippingPrice: {
        retail: Number(config?.baseShippingPrice?.retail || 0),
        wholesale: Number(config?.baseShippingPrice?.wholesale || 0),
      },
    });
  } catch (e) {
    return next(e);
  }
});

/* ======================================================================
   POST /api/shipping/calculate
   Body: { customerType: "retail" | "wholesale", orderTotal: number }

   Returns the shipping cost for the given cart total.
   All pricing logic lives in the service — React only receives the result.
   The checkout flow recalculates independently on the server before saving
   any order, so this endpoint is safe for display-only use.
====================================================================== */

const calculateSchema = z.object({
  body: z
    .object({
      customerType: z.enum(["retail", "wholesale"]),
      orderTotal:   z.number().nonnegative().finite(),
    })
    .strict(),
});

router.post(
  "/calculate",
  validate(calculateSchema),
  async (req, res, next) => {
    try {
      // Never cache — this is a personalized, dynamic computation.
      setPrivateNoStore(res);

      const { customerType, orderTotal } = req.validated.body;
      const result = await calculateShipping(customerType, orderTotal);

      return sendOk(res, result);
    } catch (e) {
      return next(e);
    }
  }
);

export default router;
