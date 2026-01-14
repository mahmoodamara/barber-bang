// src/services/cart.service.js
import mongoose from "mongoose";
import { Cart, Product, Variant } from "../models/index.js";
import { mapMoneyPairFromMinor, normalizeCurrency } from "../utils/money.js";
import { applyQueryBudget } from "../utils/queryBudget.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
}

const MAX_ITEMS = 200;
const MAX_QTY_PER_ITEM = 99;

function makeKey(productId, variantId) {
  const p = String(productId);
  const v = variantId ? String(variantId) : "";
  return `${p}:${v}`;
}

async function ensureCartDoc(userId) {
  // upsert to avoid double-query create
  const doc = await Cart.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId, itemsKeys: [], items: [] } },
    { upsert: true, new: true },
  ).lean();
  return doc;
}

async function assertProductAndVariant(productId, variantId) {
  const product = await applyQueryBudget(
    Product.findOne({ _id: productId, isDeleted: { $ne: true } })
      .select("isActive nameHe nameAr images brand slug")
      .lean(),
  );

  if (!product) throw httpError(404, "PRODUCT_NOT_FOUND", "Product not found");
  if (product.isActive === false) throw httpError(409, "PRODUCT_INACTIVE", "Product is not active");

  let variant = null;
  if (variantId) {
    variant = await applyQueryBudget(
      Variant.findOne({ _id: variantId, isDeleted: { $ne: true } })
        .select("isActive productId sku price currency options stock stockReserved")
        .lean(),
    );

    if (!variant) throw httpError(404, "VARIANT_NOT_FOUND", "Variant not found");
    if (variant.isActive === false) throw httpError(409, "VARIANT_INACTIVE", "Variant is not active");
    if (String(variant.productId) !== String(productId)) {
      throw httpError(400, "VARIANT_PRODUCT_MISMATCH", "Variant does not belong to product");
    }
  }

  return { product, variant };
}

// Optional stock guard (adjust if your schema differs)
function assertStockAvailable(variant, desiredQty) {
  if (!variant) return;
  const stock = Number.isInteger(variant.stock) ? variant.stock : null;
  const reserved = Number.isInteger(variant.stockReserved) ? variant.stockReserved : 0;
  if (stock === null) return; // no tracking
  const available = stock - reserved;
  if (desiredQty > available) {
    throw httpError(409, "INSUFFICIENT_STOCK", "Not enough stock", { available, desiredQty });
  }
}

export async function getCart({ userId, lang = "he", expand = false }) {
  const doc = await ensureCartDoc(userId);
  if (!expand) return doc;

  const productIds = [...new Set((doc.items || []).map((i) => String(i.productId)))];
  const variantIds = [...new Set((doc.items || []).filter((i) => i.variantId).map((i) => String(i.variantId)))];

  const [products, variants] = await Promise.all([
    productIds.length
      ? applyQueryBudget(
          Product.find({ _id: { $in: productIds }, isDeleted: { $ne: true } })
            .select("isActive nameHe nameAr images brand slug")
            .lean(),
        )
      : Promise.resolve([]),
    variantIds.length
      ? applyQueryBudget(
          Variant.find({ _id: { $in: variantIds }, isDeleted: { $ne: true } })
            .select("isActive productId sku price currency options stock stockReserved")
            .lean(),
        )
      : Promise.resolve([]),
  ]);

  const pMap = new Map(products.map((p) => [String(p._id), p]));
  const vMap = new Map(variants.map((v) => [String(v._id), v]));

  const items = (doc.items || []).map((it) => {
    const p = pMap.get(String(it.productId)) || null;
    const v = it.variantId ? vMap.get(String(it.variantId)) || null : null;

    const name = p ? (lang === "ar" ? p.nameAr || p.nameHe : p.nameHe) : null;

    const currency = v ? normalizeCurrency(v.currency) : null;

    return {
      ...it,
      product: p
        ? {
            id: String(p._id),
            name,
            nameHe: p.nameHe,
            nameAr: p.nameAr,
            images: p.images || [],
            brand: p.brand || "",
            slug: p.slug || "",
            isActive: p.isActive !== false,
          }
        : null,
      variant: v
        ? {
            id: String(v._id),
            productId: String(v.productId),
            sku: v.sku,
            ...mapMoneyPairFromMinor(v.price, currency, "price", "priceMinor"),
            currency,
            options: v.options || {},
            stock: v.stock ?? null,
            stockReserved: v.stockReserved ?? 0,
            isActive: v.isActive !== false,
          }
        : null,
    };
  });

  return { ...doc, items };
}

export async function addCartItem({ userId, productId, variantId, qty = 1 }) {
  const { variant } = await assertProductAndVariant(productId, variantId);
  await ensureCartDoc(userId);

  const key = makeKey(productId, variantId);
  const now = new Date();

  // If stock tracking exists, we must know current qty to enforce (optional).
  // We do a lightweight read only when variant has stock.
  if (variant && Number.isInteger(variant.stock)) {
    const existing = await applyQueryBudget(
      Cart.findOne({ userId }).select("items").lean(),
    );
    const current = existing?.items?.find((x) => x.key === key)?.qty || 0;
    assertStockAvailable(variant, Math.min(MAX_QTY_PER_ITEM, current + qty));
  }

  // Enforce MAX_ITEMS atomically:
  // allow if key already exists OR itemsKeys size < MAX_ITEMS
  const filter = {
    userId,
    $or: [
      { itemsKeys: key },
      {
        $expr: {
          $lt: [{ $size: { $ifNull: ["$itemsKeys", []] } }, MAX_ITEMS],
        },
      },
    ],
  };

  const updated = await Cart.findOneAndUpdate(
    filter,
    [
      { $set: { _k: { $ifNull: ["$itemsKeys", []] }, _i: { $ifNull: ["$items", []] } } },
      { $set: { _exists: { $in: [key, "$_k"] } } },
      {
        $set: {
          itemsKeys: { $cond: ["$_exists", "$_k", { $concatArrays: ["$_k", [key]] }] },
          items: {
            $cond: [
              "$_exists",
              {
                $map: {
                  input: "$_i",
                  as: "it",
                  in: {
                    $cond: [
                      { $eq: ["$$it.key", key] },
                      {
                        $mergeObjects: [
                          "$$it",
                          {
                            qty: { $min: [MAX_QTY_PER_ITEM, { $add: ["$$it.qty", qty] }] },
                            updatedAt: now,
                          },
                        ],
                      },
                      "$$it",
                    ],
                  },
                },
              },
              {
                $concatArrays: [
                  "$_i",
                  [
                    {
                      key,
                      productId: new mongoose.Types.ObjectId(productId),
                      variantId: variantId ? new mongoose.Types.ObjectId(variantId) : null,
                      qty: Math.min(MAX_QTY_PER_ITEM, qty),
                      addedAt: now,
                      updatedAt: now,
                    },
                  ],
                ],
              },
            ],
          },
        },
      },
      { $unset: ["_k", "_i", "_exists"] },
    ],
    { new: true },
  );

  // If filter failed due to MAX_ITEMS, updated will be null (when doc exists & key not present)
  if (!updated) throw httpError(409, "CART_LIMIT_REACHED", "Cart item limit reached");

  return updated;
}

export async function setCartItemQty({ userId, productId, variantId, qty }) {
  const { variant } = await assertProductAndVariant(productId, variantId);
  assertStockAvailable(variant, qty);

  const key = makeKey(productId, variantId);
  const now = new Date();

  const updated = await Cart.findOneAndUpdate(
    { userId, itemsKeys: key },
    [
      { $set: { _i: { $ifNull: ["$items", []] } } },
      {
        $set: {
          items: {
            $map: {
              input: "$_i",
              as: "it",
              in: {
                $cond: [{ $eq: ["$$it.key", key] }, { $mergeObjects: ["$$it", { qty, updatedAt: now }] }, "$$it"],
              },
            },
          },
        },
      },
      { $unset: ["_i"] },
    ],
    { new: true },
  );

  if (!updated) throw httpError(404, "CART_ITEM_NOT_FOUND", "Cart item not found");
  return updated;
}

export async function removeCartItem({ userId, productId, variantId }) {
  const key = makeKey(productId, variantId);

  const updated = await Cart.findOneAndUpdate(
    { userId },
    { $pull: { itemsKeys: key, items: { key } } },
    { new: true },
  );

  // ensure doc exists even if user had no cart
  if (!updated) return await ensureCartDoc(userId);
  return updated;
}

export async function clearCart({ userId }) {
  const updated = await Cart.findOneAndUpdate(
    { userId },
    { $set: { itemsKeys: [], items: [] } },
    { upsert: true, new: true },
  );
  return updated;
}
