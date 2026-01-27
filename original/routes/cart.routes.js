import express from "express";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { User } from "../models/User.js";
import { Product } from "../models/Product.js";

const router = express.Router();

router.get("/", requireAuth(), async (req, res) => {
  const user = await User.findById(req.user._id).populate("cart.productId");
  const items = (user.cart || []).map((ci) => ({
    product: ci.productId,
    qty: ci.qty,
  }));
  res.json({ ok: true, data: items });
});

const addSchema = z.object({
  body: z.object({
    productId: z.string().min(1),
    qty: z.number().int().min(1).max(999),
  }),
});

router.post("/add", requireAuth(), validate(addSchema), async (req, res) => {
  const { productId, qty } = req.validated.body;

  const product = await Product.findById(productId);
  if (!product || !product.isActive) {
    return res.status(404).json({
      ok: false,
      error: { code: "NOT_FOUND", message: "Product not found" },
    });
  }

  const user = await User.findById(req.user._id);
  const idx = user.cart.findIndex((x) => x.productId.toString() === productId);

  if (idx >= 0) user.cart[idx].qty = Math.min(user.cart[idx].qty + qty, 999);
  else user.cart.push({ productId, qty });

  await user.save();
  res.json({ ok: true, data: user.cart });
});

const setQtySchema = z.object({
  body: z.object({
    productId: z.string().min(1),
    qty: z.number().int().min(1).max(999),
  }),
});

router.post("/set-qty", requireAuth(), validate(setQtySchema), async (req, res) => {
  const { productId, qty } = req.validated.body;
  const user = await User.findById(req.user._id);
  const idx = user.cart.findIndex((x) => x.productId.toString() === productId);
  if (idx < 0) {
    return res.status(404).json({
      ok: false,
      error: { code: "NOT_FOUND", message: "Item not found in cart" },
    });
  }
  user.cart[idx].qty = qty;
  await user.save();
  res.json({ ok: true, data: user.cart });
});

const removeSchema = z.object({
  body: z.object({
    productId: z.string().min(1),
  }),
});

router.post("/remove", requireAuth(), validate(removeSchema), async (req, res) => {
  const { productId } = req.validated.body;

  const user = await User.findById(req.user._id);
  user.cart = user.cart.filter((x) => x.productId.toString() !== productId);
  await user.save();

  res.json({ ok: true, data: user.cart });
});

router.post("/clear", requireAuth(), async (req, res) => {
  const user = await User.findById(req.user._id);
  user.cart = [];
  await user.save();
  res.json({ ok: true, data: [] });
});

export default router;
