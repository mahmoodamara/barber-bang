// src/services/wishlist.service.js
import mongoose from "mongoose";
import { Wishlist, Product } from "../models/index.js";
import { Variant } from "../models/Variant.js";
import { mapMoneyPairFromMinor, normalizeCurrency } from "../utils/money.js";
import { applyQueryBudget } from "../utils/queryBudget.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function makeKey(productId, variantId) {
  const p = String(productId);
  const v = variantId ? String(variantId) : "";
  return `${p}:${v}`;
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
        .select("isActive productId sku price currency options")
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

export async function getWishlist({ userId, lang = "he", expand = false }) {
  const doc =
    (await applyQueryBudget(Wishlist.findOne({ userId }).lean())) ||
    (await Wishlist.create({ userId, itemsKeys: [], items: [] }).then((d) => d.toObject()));

  if (!expand) return doc;

  const productIds = [...new Set(doc.items.map((i) => String(i.productId)))];
  const variantIds = [...new Set(doc.items.filter((i) => i.variantId).map((i) => String(i.variantId)))];

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
            .select("isActive productId sku price currency options")
            .lean(),
        )
      : Promise.resolve([]),
  ]);

  const pMap = new Map(products.map((p) => [String(p._id), p]));
  const vMap = new Map(variants.map((v) => [String(v._id), v]));

  const items = doc.items.map((it) => {
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
            isActive: v.isActive !== false,
          }
        : null,
    };
  });

  return { ...doc, items };
}

export async function addWishlistItem({ userId, productId, variantId, limit = 200 }) {
  await assertProductAndVariant(productId, variantId);

  const key = makeKey(productId, variantId);

  // lightweight guardrail (fast path)
  const existing = await applyQueryBudget(
    Wishlist.findOne({ userId }).select("itemsKeys").lean(),
  );
  if (existing) {
    const has = existing.itemsKeys?.includes(key);
    const count = existing.itemsKeys?.length || 0;
    if (!has && count >= limit) {
      throw httpError(409, "WISHLIST_LIMIT_REACHED", "Wishlist item limit reached");
    }
  }

  const now = new Date();

  // Atomic pipeline update: add key if missing; append item only if key was newly added
  const updated = await Wishlist.findOneAndUpdate(
    { userId },
    [
      { $set: { _k: { $ifNull: ["$itemsKeys", []] }, _i: { $ifNull: ["$items", []] } } },
      { $set: { _nk: { $setUnion: ["$_k", [key]] } } },
      { $set: { _added: { $gt: [{ $size: "$_nk" }, { $size: "$_k" }] } } },
      {
        $set: {
          itemsKeys: "$_nk",
          items: {
            $cond: [
              "$_added",
              {
                $concatArrays: [
                  "$_i",
                  [
                    {
                      key,
                      productId: new mongoose.Types.ObjectId(productId),
                      variantId: variantId ? new mongoose.Types.ObjectId(variantId) : null,
                      addedAt: now,
                    },
                  ],
                ],
              },
              "$_i",
            ],
          },
        },
      },
      { $unset: ["_k", "_i", "_nk", "_added"] },
    ],
    { upsert: true, new: true },
  );

  return updated;
}

export async function removeWishlistItem({ userId, productId, variantId }) {
  const key = makeKey(productId, variantId);

  const updated = await Wishlist.findOneAndUpdate(
    { userId },
    { $pull: { itemsKeys: key, items: { key } } },
    { new: true },
  );

  if (!updated) {
    return Wishlist.create({ userId, itemsKeys: [], items: [] });
  }
  return updated;
}

export async function clearWishlist({ userId }) {
  return Wishlist.findOneAndUpdate(
    { userId },
    { $set: { itemsKeys: [], items: [] } },
    { upsert: true, new: true },
  );
}
