import express from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { StockNotification } from "../models/StockNotification.js";

const router = express.Router();

const subscribeSchema = z.object({
  body: z.object({
    email: z.string().email().max(255),
    productId: z.string().min(1),
    variantId: z.string().optional().default(""),
  }),
});

router.post("/subscribe", validate(subscribeSchema), async (req, res) => {
  try {
    const { email, productId, variantId } = req.validated?.body ?? req.body;

    const existing = await StockNotification.findOne({
      email: email.toLowerCase(),
      productId,
      variantId: variantId || "",
    });

    if (existing) {
      if (existing.notified) {
        existing.notified = false;
        existing.notifiedAt = null;
        await existing.save();
      }
      return res.json({ ok: true, data: { subscribed: true } });
    }

    await StockNotification.create({
      email: email.toLowerCase(),
      productId,
      variantId: variantId || "",
    });

    return res.status(201).json({ ok: true, data: { subscribed: true } });
  } catch (e) {
    if (e.code === 11000) {
      return res.json({ ok: true, data: { subscribed: true } });
    }
    return res
      .status(500)
      .json({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: e.message },
      });
  }
});

export default router;
