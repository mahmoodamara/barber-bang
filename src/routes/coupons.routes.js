import express from "express";

import { Coupon } from "../models/Coupon.js";
import { getRequestId } from "../middleware/error.js";
import { limitCouponValidate } from "../middleware/rateLimit.js";

const router = express.Router();

function errorPayload(req, code, message) {
  return {
    ok: false,
    error: {
      code,
      message,
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
    },
  };
}

router.get("/validate", limitCouponValidate, async (req, res) => {
  const code = String(req.query.code || "")
    .trim()
    .toUpperCase();
  if (!code) {
    return res
      .status(400)
      .json(errorPayload(req, "VALIDATION_ERROR", "code is required"));
  }

  const now = new Date();
  const coupon = await Coupon.findOne({ code });
  const valid = Boolean(
    coupon &&
    coupon.isActive &&
    (!coupon.startAt || now >= coupon.startAt) &&
    (!coupon.endAt || now <= coupon.endAt) &&
    (coupon.usageLimit == null ||
      Number(coupon.usedCount || 0) + Number(coupon.reservedCount || 0) <
        coupon.usageLimit),
  );

  if (!valid) {
    return res.json({ ok: true, data: { valid: false } });
  }

  return res.json({
    ok: true,
    data: {
      valid: true,
      coupon: {
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
        minOrderTotal: coupon.minOrderTotal,
        maxDiscount: coupon.maxDiscount,
      },
    },
  });
});

export default router;
