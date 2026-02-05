// src/services/guestCart.service.js
import { randomUUID } from "node:crypto";
import { GuestCart } from "../models/GuestCart.js";
import { User } from "../models/User.js";
import { Product } from "../models/Product.js";

const CART_ID_COOKIE = "guest_cart_id";
const CART_ID_HEADER = "x-guest-cart-id";
const CART_ID_MAX_AGE_DAYS = 30;

function getCookieValue(req, name) {
  const raw = req?.headers?.cookie;
  if (!raw || typeof raw !== "string") return null;
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1].trim()) : null;
}

/**
 * Extract guest cart ID from request (cookie or header)
 */
export function getGuestCartIdFromRequest(req) {
  const fromCookie = getCookieValue(req, CART_ID_COOKIE);
  if (fromCookie) return String(fromCookie).trim().slice(0, 64) || null;
  const fromHeader = req?.headers?.[CART_ID_HEADER] || req?.headers?.["x-guest-cart-id"];
  if (fromHeader && typeof fromHeader === "string") {
    return String(fromHeader).trim().slice(0, 64) || null;
  }
  return null;
}

/**
 * Get cookie options for setting guest cart ID
 */
export function getGuestCartCookieOptions() {
  return {
    maxAge: CART_ID_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
    httpOnly: false, // Allow JS read for SPA localStorage fallback
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}

/**
 * Get or create guest cart. Returns { cartId, cart } or null if no cartId provided and createIfMissing is false.
 */
export async function getOrCreateGuestCart(cartId, { createIfMissing = false } = {}) {
  if (cartId) {
    const cart = await GuestCart.findOne({ cartId }).lean();
    if (cart) {
      await GuestCart.updateOne({ cartId }, { $set: { updatedAt: new Date() } }).catch(() => {});
      return { cartId, cart };
    }
  }
  if (!createIfMissing) return null;
  const newCartId = randomUUID();
  await GuestCart.create({
    cartId: newCartId,
    items: [],
    updatedAt: new Date(),
  });
  return { cartId: newCartId, cart: { cartId: newCartId, items: [] } };
}

/**
 * Merge guest cart into user cart and delete guest cart.
 * Combines quantities for same product+variant.
 */
export async function mergeGuestCartIntoUser(userId, guestCartId) {
  if (!userId || !guestCartId) return { merged: 0 };
  const [user, guestCart] = await Promise.all([
    User.findById(userId).select("cart"),
    GuestCart.findOne({ cartId: guestCartId }).lean(),
  ]);
  if (!user || !guestCart?.items?.length) return { merged: 0 };

  let mergedCount = 0;
  const userCart = user.cart || [];
  const existingKeys = new Set(
    userCart.map((c) => `${c.productId}:${String(c.variantId || "")}`)
  );

  for (const gi of guestCart.items) {
    const key = `${gi.productId}:${String(gi.variantId || "")}`;
    const idx = userCart.findIndex(
      (c) =>
        String(c.productId) === String(gi.productId) &&
        String(c.variantId || "") === String(gi.variantId || "")
    );
    if (idx >= 0) {
      const newQty = Math.min(999, (userCart[idx].qty || 0) + (gi.qty || 1));
      userCart[idx].qty = newQty;
      mergedCount += 1;
    } else {
      userCart.push({
        productId: gi.productId,
        qty: Math.min(999, gi.qty || 1),
        variantId: String(gi.variantId || ""),
        variantSnapshot: gi.variantSnapshot || null,
      });
      mergedCount += 1;
    }
  }

  if (mergedCount > 0) {
    await User.updateOne({ _id: userId }, { $set: { cart: userCart } });
  }
  await GuestCart.deleteOne({ cartId: guestCartId }).catch(() => {});

  return { merged: mergedCount };
}
