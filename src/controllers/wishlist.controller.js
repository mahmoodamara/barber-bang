// src/controllers/wishlist.controller.js
import { wishlistQuerySchema } from "../validators/wishlist.validators.js";
import {
  getWishlist,
  addWishlistItem,
  removeWishlistItem,
  clearWishlist,
} from "../services/wishlist.service.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";

function normalizeId(id) {
  if (!id) return null;
  if (typeof id === "string") return id;
  if (typeof id === "object") {
    if ("_id" in id && id._id) return String(id._id);
    if ("id" in id && id.id) return String(id.id);
  }
  return String(id);
}

function pickAuth(req) {
  const a = req.auth || {};
  return { userId: a.userId };
}

/**
 * ─────────────────────────────────────────────────────────────
 * DTO
 * ─────────────────────────────────────────────────────────────
 */
function toWishlistDTO(doc) {
  if (!doc) return doc;

  const items = Array.isArray(doc.items)
    ? doc.items.map((it) => ({
        productId: normalizeId(it.productId),
        variantId: normalizeId(it.variantId),
        addedAt: it.addedAt,
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

/**
 * ─────────────────────────────────────────────────────────────
 * Controllers
 * ─────────────────────────────────────────────────────────────
 */
export async function getMyWishlist(req, res) {
  const { userId } = pickAuth(req);
  const q = wishlistQuerySchema.parse(req.query || {});
  const doc = await getWishlist({
    userId,
    lang: req.lang,
    expand: Boolean(q.expand),
  });

  res.json({ ok: true, wishlist: toWishlistDTO(doc) });
}

export async function addWishlist(req, res) {
  const { userId } = pickAuth(req);
  const body = req.validated.body; // validate() middleware

  try {
    const doc = await addWishlistItem({
      userId,
      productId: body.productId,
      variantId: body.variantId || null,
    });

    await logAuditSuccess(req, AuditActions.WISHLIST_ADD, {
      type: "Wishlist",
      id: normalizeId(doc._id),
    }, { message: `Added product ${body.productId}` });

    res.json({ ok: true, wishlist: toWishlistDTO(doc) });
  } catch (err) {
    await logAuditFail(req, AuditActions.WISHLIST_ADD, { type: "Wishlist" }, err);
    throw err;
  }
}

export async function removeWishlist(req, res) {
  const { userId } = pickAuth(req);

  const productId = req.params.productId;
  const variantId = req.query?.variantId ? String(req.query.variantId) : null;

  try {
    const doc = await removeWishlistItem({ userId, productId, variantId });

    await logAuditSuccess(req, AuditActions.WISHLIST_REMOVE, {
      type: "Wishlist",
      id: normalizeId(doc._id),
    }, { message: `Removed product ${productId}` });

    res.json({ ok: true, wishlist: toWishlistDTO(doc) });
  } catch (err) {
    await logAuditFail(req, AuditActions.WISHLIST_REMOVE, { type: "Wishlist" }, err);
    throw err;
  }
}

export async function clearMyWishlist(req, res) {
  const { userId } = pickAuth(req);

  try {
    const doc = await clearWishlist({ userId });

    await logAuditSuccess(req, AuditActions.WISHLIST_CLEAR, {
      type: "Wishlist",
      id: normalizeId(doc._id),
    });

    res.json({ ok: true, wishlist: toWishlistDTO(doc) });
  } catch (err) {
    await logAuditFail(req, AuditActions.WISHLIST_CLEAR, { type: "Wishlist" }, err);
    throw err;
  }
}
