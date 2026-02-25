import express from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { NewsletterSubscriber } from "../models/NewsletterSubscriber.js";

const router = express.Router();

const subscribeSchema = z.object({
  body: z.object({
    email: z.string().email().max(255),
    source: z.enum(["footer", "popup", "checkout", "api"]).optional(),
    lang: z.enum(["he", "ar", "en"]).optional(),
  }),
});

router.post("/subscribe", validate(subscribeSchema), async (req, res) => {
  try {
    const { email, source, lang } = req.validated?.body ?? req.body;

    const existing = await NewsletterSubscriber.findOne({
      email: email.toLowerCase(),
    });
    if (existing) {
      if (!existing.isActive) {
        existing.isActive = true;
        await existing.save();
      }
      return res.json({ ok: true, data: { subscribed: true } });
    }

    await NewsletterSubscriber.create({
      email: email.toLowerCase(),
      source: source || "footer",
      lang: lang || "he",
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
