import express from "express";

import { Coupon } from "../models/Coupon.js";

const router = express.Router();

router.get("/validate", async (req, res) => {
  const code = String(req.query.code || "").trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ ok: false, error: { code: "VALIDATION_ERROR", message: "code is required" } });
  }

  const now = new Date();
  const coupon = await Coupon.findOne({ code });
  const valid = Boolean(
    coupon &&
      coupon.isActive &&
      (!coupon.startAt || now >= coupon.startAt) &&
      (!coupon.endAt || now <= coupon.endAt) &&
      (coupon.usageLimit == null || coupon.usedCount < coupon.usageLimit),
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
