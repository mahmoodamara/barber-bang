// src/controllers/cart.controller.js
import mongoose from "mongoose";
import { cartQuerySchema, removeCartItemQuerySchema } from "../validators/cart.validators.js";
import { getCart, addCartItem, setCartItemQty, removeCartItem, clearCart } from "../services/cart.service.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";

function normalizeId(id) {
  return id ? String(id) : null;
}

function toCartDTO(doc) {
  if (!doc) return doc;
  const items = Array.isArray(doc.items)
    ? doc.items.map((it) => ({
        productId: normalizeId(it.productId),
        variantId: normalizeId(it.variantId),
        qty: it.qty,
        addedAt: it.addedAt,
        updatedAt: it.updatedAt,
        ...(it.product ? { product: it.product } : {}),
        ...(it.variant ? { variant: it.variant } : {}),
      }))
    : [];

  return {
    id: normalizeId(doc._id || doc.id),
    items,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function pickAuth(req) {
  const a = req.auth || req.user || {};
  const userId = a.userId || a.id || a._id;
  if (!mongoose.isValidObjectId(userId)) {
    const err = new Error("AUTH_INVALID");
    err.statusCode = 401;
    throw err;
  }
  return { userId };
}

export async function getMyCart(req, res) {
  const { userId } = pickAuth(req);
  const q = cartQuerySchema.parse(req.query || {});
  const doc = await getCart({ userId, lang: req.lang, expand: !!q.expand });
  return res.status(200).json({ ok: true, data: toCartDTO(doc) });
}

export async function addItem(req, res) {
  const { userId } = pickAuth(req);
  const body = req.validated?.body || req.body;

  try {
    const doc = await addCartItem({
      userId,
      productId: body.productId,
      variantId: body.variantId || null,
      qty: body.qty ?? 1,
    });

    await logAuditSuccess(req, AuditActions.CART_ADD_ITEM, {
      type: "Cart",
      id: normalizeId(doc._id),
    }, { message: `Added product ${body.productId} qty=${body.qty ?? 1}` });

    return res.status(200).json({ ok: true, data: toCartDTO(doc) });
  } catch (err) {
    await logAuditFail(req, AuditActions.CART_ADD_ITEM, { type: "Cart" }, err);
    throw err;
  }
}

export async function setQty(req, res) {
  const { userId } = pickAuth(req);

  const productId = req.params.productId;
  const variantId = req.query?.variantId ? String(req.query.variantId) : null;
  const body = req.validated?.body || req.body;

  try {
    const doc = await setCartItemQty({ userId, productId, variantId, qty: body.qty });

    await logAuditSuccess(req, AuditActions.CART_SET_QTY, {
      type: "Cart",
      id: normalizeId(doc._id),
    }, { message: `Set product ${productId} qty=${body.qty}` });

    return res.status(200).json({ ok: true, data: toCartDTO(doc) });
  } catch (err) {
    await logAuditFail(req, AuditActions.CART_SET_QTY, { type: "Cart" }, err);
    throw err;
  }
}

export async function removeItem(req, res) {
  const { userId } = pickAuth(req);

  const productId = req.params.productId;
  const q = removeCartItemQuerySchema.parse(req.query || {});
  const variantId = q.variantId ? String(q.variantId) : null;

  try {
    const doc = await removeCartItem({ userId, productId, variantId });

    await logAuditSuccess(req, AuditActions.CART_REMOVE_ITEM, {
      type: "Cart",
      id: normalizeId(doc._id),
    }, { message: `Removed product ${productId}` });

    return res.status(200).json({ ok: true, data: toCartDTO(doc) });
  } catch (err) {
    await logAuditFail(req, AuditActions.CART_REMOVE_ITEM, { type: "Cart" }, err);
    throw err;
  }
}

export async function clearMyCart(req, res) {
  const { userId } = pickAuth(req);

  try {
    const doc = await clearCart({ userId });

    await logAuditSuccess(req, AuditActions.CART_CLEAR, {
      type: "Cart",
      id: normalizeId(doc._id),
    });

    return res.status(200).json({ ok: true, data: toCartDTO(doc) });
  } catch (err) {
    await logAuditFail(req, AuditActions.CART_CLEAR, { type: "Cart" }, err);
    throw err;
  }
}
