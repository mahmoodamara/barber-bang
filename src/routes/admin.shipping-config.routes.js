// src/routes/admin.shipping-config.routes.js
// Allows admins to view and update shipping rules (thresholds + base prices).
// Requires SETTINGS_WRITE permission — no hardcoded values survive here.

import express from "express";
import { z } from "zod";

import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { sendOk, sendError } from "../utils/response.js";
import { ShippingConfig } from "../models/ShippingConfig.js";
import {
  getShippingConfig,
  invalidateShippingConfigCache,
} from "../services/shipping.service.js";

const router = express.Router();

// ── Guards: all routes require admin auth + SETTINGS_WRITE ────────────────
router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.SETTINGS_WRITE));
router.use(auditAdmin());

// ── Zod schema for update body ────────────────────────────────────────────
const updateSchema = z.object({
  body: z
    .object({
      freeShippingThreshold: z
        .object({
          retail:    z.number().nonnegative().finite(),
          wholesale: z.number().nonnegative().finite(),
        })
        .strict(),
      baseShippingPrice: z
        .object({
          retail:    z.number().nonnegative().finite(),
          wholesale: z.number().nonnegative().finite(),
        })
        .strict(),
    })
    .strict(),
});

/* ============================
   GET /api/admin/shipping-config
   Returns the current shipping rules.
============================ */
router.get("/", async (req, res, next) => {
  try {
    const config = await getShippingConfig();
    return sendOk(res, mapConfig(config));
  } catch (e) {
    return next(e);
  }
});

/* ============================
   PUT /api/admin/shipping-config
   Replaces all shipping rules in one atomic update.
   Body: { freeShippingThreshold: { retail, wholesale }, baseShippingPrice: { retail, wholesale } }
============================ */
router.put("/", validate(updateSchema), async (req, res, next) => {
  try {
    const { freeShippingThreshold, baseShippingPrice } = req.validated.body;

    // Upsert: find the singleton and apply changes, or create on first use.
    const config = await ShippingConfig.findOneAndUpdate(
      {},
      {
        $set: {
          "freeShippingThreshold.retail":    freeShippingThreshold.retail,
          "freeShippingThreshold.wholesale": freeShippingThreshold.wholesale,
          "baseShippingPrice.retail":        baseShippingPrice.retail,
          "baseShippingPrice.wholesale":     baseShippingPrice.wholesale,
        },
      },
      { upsert: true, new: true, runValidators: true }
    ).lean();

    // Bust the service-layer cache so the next calculation uses fresh values.
    invalidateShippingConfigCache();

    return sendOk(res, mapConfig(config));
  } catch (e) {
    return next(e);
  }
});

// ── Mapper: expose only public fields ────────────────────────────────────
function mapConfig(doc) {
  return {
    id: doc._id,
    freeShippingThreshold: {
      retail:    doc.freeShippingThreshold.retail,
      wholesale: doc.freeShippingThreshold.wholesale,
    },
    baseShippingPrice: {
      retail:    doc.baseShippingPrice.retail,
      wholesale: doc.baseShippingPrice.wholesale,
    },
    updatedAt: doc.updatedAt,
  };
}

export default router;
