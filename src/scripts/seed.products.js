// src/scripts/seed.full.js
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { toMinorUnits } from "../utils/stripe.js";

// ---- Model imports (robust fallback for default/named exports) ----
import * as UserMod from "../models/User.js";
import * as CategoryMod from "../models/Category.js";
import * as ProductMod from "../models/Product.js";
import * as VariantMod from "../models/Variant.js";

import * as CouponMod from "../models/Coupon.js";
import * as ShippingMethodMod from "../models/ShippingMethod.js";

// optional models - if they exist in your codebase, we will wipe them safely
const optionalModelImports = [
  ["Cart", () => import("../models/Cart.js")],
  ["Order", () => import("../models/Order.js")],
  ["Review", () => import("../models/Review.js")],
  ["Wishlist", () => import("../models/Wishlist.js")],
  ["CouponRedemption", () => import("../models/CouponRedemption.js")],
  ["StockLog", () => import("../models/StockLog.js")],
  ["StockReservation", () => import("../models/StockReservation.js")],
  ["StripeEvent", () => import("../models/StripeEvent.js")],
  ["Invoice", () => import("../models/Invoice.js")],
  ["RefundRequest", () => import("../models/RefundRequest.js")],
  ["Job", () => import("../models/Job.js")],
  ["LeaseLock", () => import("../models/LeaseLock.js")],
  ["IdempotencyRecord", () => import("../models/IdempotencyRecord.js")],
  ["RateLimitBucket", () => import("../models/RateLimitBucket.js")],
  ["FeatureFlag", () => import("../models/FeatureFlag.js")],
  ["ReadModel", () => import("../models/ReadModel.js")],
  ["AuditLog", () => import("../models/AuditLog.js")],
  ["AlertLog", () => import("../models/AlertLog.js")],
];

function pickModel(mod, fallbackName) {
  return mod?.default ?? mod?.[fallbackName] ?? mod?.model ?? null;
}

const User = pickModel(UserMod, "User");
const Category = pickModel(CategoryMod, "Category");
const Product = pickModel(ProductMod, "Product");
const Variant = pickModel(VariantMod, "Variant");
const Coupon = pickModel(CouponMod, "Coupon");
const ShippingMethod = pickModel(ShippingMethodMod, "ShippingMethod");

if (!User || !Category || !Product || !Variant) {
  throw new Error(
    "Missing required models. Ensure these exist and paths are correct: User, Category, Product, Variant."
  );
}

// ---- Connection ----
function getMongoUri() {
  return process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL || "";
}

async function connectDb() {
  const uri = getMongoUri();
  if (!uri) {
    throw new Error("Missing Mongo URI. Set MONGO_URI (or MONGODB_URI / DATABASE_URL).");
  }

  await mongoose.connect(uri, {
    autoIndex: false,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,
  });
}

// ---- Helpers ----
const now = () => new Date();

function assertConfirmWipe() {
  const ok = String(process.env.SEED_CONFIRM || "").toUpperCase() === "YES";
  if (!ok) {
    throw new Error("Refusing to wipe DB without confirmation. Set SEED_CONFIRM=YES then run again.");
  }
}

// IMPORTANT: store ISO currency codes in DB (NOT symbols like ₪)
const CURRENCY = "ILS"; // ISO 4217
const CURRENCY_SYMBOL = "₪"; // UI only (never store this in DB)

function toSlug(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/(^-|-$)/g, "");
}

function makeCat({ key, nameHe, nameAr, slug, parentKey = null, sortOrder = 0, isActive = true, image = null }) {
  return { key, nameHe, nameAr, slug: slug || toSlug(key), parentKey, sortOrder, isActive, image };
}

/**
 * Build tree metadata:
 * - parentId
 * - ancestors (array of ids)
 * - level
 * - fullSlug (parentFullSlug/slug)
 */
async function insertCategoriesTree(categoriesInput) {
  const mapByKey = new Map(categoriesInput.map((c) => [c.key, c]));
  const insertedByKey = new Map();

  function computePathKeys(key) {
    const out = [];
    let cur = mapByKey.get(key);
    while (cur) {
      out.unshift(cur.key);
      cur = cur.parentKey ? mapByKey.get(cur.parentKey) : null;
    }
    return out;
  }

  // Sort by depth so parents come first
  const sorted = [...categoriesInput].sort((a, b) => {
    const da = computePathKeys(a.key).length;
    const db = computePathKeys(b.key).length;
    return da - db;
  });

  for (const c of sorted) {
    const parent = c.parentKey ? insertedByKey.get(c.parentKey) : null;

    const level = parent ? (parent.level ?? 0) + 1 : 0;
    const fullSlug = parent ? `${parent.fullSlug}/${c.slug}` : c.slug;
    const ancestors = parent ? [...(parent.ancestors ?? []), parent._id] : [];

    const doc = await Category.create({
      nameHe: c.nameHe,
      nameAr: c.nameAr,
      slug: c.slug,
      fullSlug,
      parentId: parent?._id ?? null,
      ancestors,
      level,
      sortOrder: c.sortOrder ?? 0,
      isActive: c.isActive ?? true,
      image: c.image ?? null,
    });

    insertedByKey.set(c.key, doc);
  }

  return insertedByKey;
}

// money() returns minor units (agorot) for DB storage
function money(n) {
  return toMinorUnits(n, CURRENCY);
}

async function safeDeleteMany(model, name) {
  if (!model) return;
  try {
    const res = await model.deleteMany({});
    console.log(`🧹 wiped ${name}:`, res?.deletedCount ?? "ok");
  } catch (e) {
    console.warn(`⚠️ could not wipe ${name}:`, e?.message || e);
  }
}

async function loadOptionalModels() {
  const out = new Map();
  for (const [name, loader] of optionalModelImports) {
    try {
      const mod = await loader();
      const m = pickModel(mod, name);
      if (m) out.set(name, m);
    } catch {
      // ignore missing files
    }
  }
  return out;
}

/**
 * ✅ Deterministic mix of inStock true/false,
 * and keep variants stock consistent with inStock.
 *
 * Pattern:
 * - every 3rd product: out of stock
 * - otherwise: in stock
 */
function withStockFlag(products) {
  return products.map((p, i) => {
    const inStock = i % 3 !== 0;

    const variants = (p.variants ?? []).map((v) => {
      const baseQty = Number(v.stock ?? 0);
      const qty = inStock ? Math.max(0, baseQty) : 0;
      return { ...v, stock: qty };
    });

    return { ...p, inStock, variants };
  });
}

// =====================================================
// 🖼️ IMAGE COLLECTIONS - Professional Barber Equipment
// =====================================================

const IMAGES = {
  // ---- CATEGORIES ----
  categories: {
    clippers: "https://images.unsplash.com/photo-1621607512022-6aecc4fed814?w=800&h=600&fit=crop&q=80",
    clippers_wired: "https://images.unsplash.com/photo-1582095133179-bfd08e2fc6b3?w=800&h=600&fit=crop&q=80",
    clippers_wireless: "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    trimmers: "https://images.unsplash.com/photo-1621605815971-fbc98d665033?w=800&h=600&fit=crop&q=80",
    trimmers_zero: "https://images.unsplash.com/photo-1599351431202-1e0f0137899a?w=800&h=600&fit=crop&q=80",
    trimmers_nose: "https://images.unsplash.com/photo-1626808642875-0aa545482dfb?w=800&h=600&fit=crop&q=80",
    shavers: "https://images.unsplash.com/photo-1621607505837-4c5fe8a63d63?w=800&h=600&fit=crop&q=80",
    blades: "https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=800&h=600&fit=crop&q=80",
    care: "https://images.unsplash.com/photo-1598524374912-6b0b0bdb9dd6?w=800&h=600&fit=crop&q=80",
    care_oils: "https://images.unsplash.com/photo-1608248597279-f99d160bfcbc?w=800&h=600&fit=crop&q=80",
    care_balms: "https://images.unsplash.com/photo-1626808642875-0aa545482dfb?w=800&h=600&fit=crop&q=80",
    accessories: "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    accessories_combs: "https://images.unsplash.com/photo-1527799820374-dcf8d9d4a388?w=800&h=600&fit=crop&q=80",
    accessories_cap: "https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=800&h=600&fit=crop&q=80",
  },

  // ---- PRODUCTS ----
  products: {
    // Wahl Magic Clip
    wahlMagicClip: [
      "https://images.unsplash.com/photo-1621607512022-6aecc4fed814?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1582095133179-bfd08e2fc6b3?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    ],
    // Andis T-Outliner
    andisTOutliner: [
      "https://images.unsplash.com/photo-1621605815971-fbc98d665033?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1599351431202-1e0f0137899a?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1622286342621-4bd786c2447c?w=800&h=600&fit=crop&q=80",
    ],
    // BaBylissPRO Foil Shaver
    babylissFoil: [
      "https://images.unsplash.com/photo-1621607505837-4c5fe8a63d63?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1626808642875-0aa545482dfb?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=800&h=600&fit=crop&q=80",
    ],
    // Blade Set
    bladeSet: [
      "https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1621607512022-6aecc4fed814?w=800&h=600&fit=crop&q=80",
    ],
    // Beard Oil
    beardOil: [
      "https://images.unsplash.com/photo-1598524374912-6b0b0bdb9dd6?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1608248597279-f99d160bfcbc?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1626808642875-0aa545482dfb?w=800&h=600&fit=crop&q=80",
    ],
    // Carbon Comb
    carbonComb: [
      "https://images.unsplash.com/photo-1527799820374-dcf8d9d4a388?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    ],
    // Oster Classic 76
    osterClassic: [
      "https://images.unsplash.com/photo-1582095133179-bfd08e2fc6b3?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1621607512022-6aecc4fed814?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    ],
    // Moser Chromini
    moserChromini: [
      "https://images.unsplash.com/photo-1599351431202-1e0f0137899a?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1621605815971-fbc98d665033?w=800&h=600&fit=crop&q=80",
    ],
    // Gamma+ Ergo
    gammaErgo: [
      "https://images.unsplash.com/photo-1621607512022-6aecc4fed814?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1582095133179-bfd08e2fc6b3?w=800&h=600&fit=crop&q=80",
    ],
    // Nose Trimmer
    noseTrimmer: [
      "https://images.unsplash.com/photo-1626808642875-0aa545482dfb?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1621605815971-fbc98d665033?w=800&h=600&fit=crop&q=80",
    ],
    // Beard Balm
    beardBalm: [
      "https://images.unsplash.com/photo-1608248597279-f99d160bfcbc?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1598524374912-6b0b0bdb9dd6?w=800&h=600&fit=crop&q=80",
    ],
    // Barber Cape
    barberCape: [
      "https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    ],
    // Clipper Oil
    clipperOil: [
      "https://images.unsplash.com/photo-1598524374912-6b0b0bdb9dd6?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1621607512022-6aecc4fed814?w=800&h=600&fit=crop&q=80",
    ],
    // Styling Brush
    stylingBrush: [
      "https://images.unsplash.com/photo-1527799820374-dcf8d9d4a388?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    ],
  },
};

// ---- Seed Data ----
function seedCategories() {
  return [
    makeCat({
      key: "clippers",
      nameHe: "מכונות תספורת",
      nameAr: "ماكينات قص",
      slug: "clippers",
      sortOrder: 10,
      image: IMAGES.categories.clippers,
    }),
    makeCat({
      key: "trimmers",
      nameHe: "טרימרים",
      nameAr: "تريمر",
      slug: "trimmers",
      sortOrder: 20,
      image: IMAGES.categories.trimmers,
    }),
    makeCat({
      key: "shavers",
      nameHe: "מכונות גילוח",
      nameAr: "ماكينات حلاقة",
      slug: "shavers",
      sortOrder: 30,
      image: IMAGES.categories.shavers,
    }),
    makeCat({
      key: "blades",
      nameHe: "סכינים וראשים",
      nameAr: "شفرات ورؤوس",
      slug: "blades",
      sortOrder: 40,
      image: IMAGES.categories.blades,
    }),
    makeCat({
      key: "care",
      nameHe: "טיפוח זקן",
      nameAr: "العناية باللحية",
      slug: "beard-care",
      sortOrder: 50,
      image: IMAGES.categories.care,
    }),
    makeCat({
      key: "accessories",
      nameHe: "אביזרים",
      nameAr: "اكسسوارات",
      slug: "accessories",
      sortOrder: 60,
      image: IMAGES.categories.accessories,
    }),

    // Children Categories
    makeCat({
      key: "clippers_wired",
      parentKey: "clippers",
      nameHe: "חוטי",
      nameAr: "سلكي",
      slug: "wired",
      sortOrder: 11,
      image: IMAGES.categories.clippers_wired,
    }),
    makeCat({
      key: "clippers_wireless",
      parentKey: "clippers",
      nameHe: "אלחוטי",
      nameAr: "لاسلكي",
      slug: "wireless",
      sortOrder: 12,
      image: IMAGES.categories.clippers_wireless,
    }),

    makeCat({
      key: "trimmers_zero",
      parentKey: "trimmers",
      nameHe: "אפס/דיוק",
      nameAr: "زيرو/دقة",
      slug: "zero",
      sortOrder: 21,
      image: IMAGES.categories.trimmers_zero,
    }),
    makeCat({
      key: "trimmers_nose",
      parentKey: "trimmers",
      nameHe: "אף ואוזניים",
      nameAr: "أنف وأذن",
      slug: "nose-ear",
      sortOrder: 22,
      image: IMAGES.categories.trimmers_nose,
    }),

    makeCat({
      key: "care_oils",
      parentKey: "care",
      nameHe: "שמנים",
      nameAr: "زيوت",
      slug: "oils",
      sortOrder: 51,
      image: IMAGES.categories.care_oils,
    }),
    makeCat({
      key: "care_balms",
      parentKey: "care",
      nameHe: "בלמים/קרם",
      nameAr: "بلسم/كريم",
      slug: "balms",
      sortOrder: 52,
      image: IMAGES.categories.care_balms,
    }),

    makeCat({
      key: "accessories_combs",
      parentKey: "accessories",
      nameHe: "מסרקים",
      nameAr: "أمشاط",
      slug: "combs",
      sortOrder: 61,
      image: IMAGES.categories.accessories_combs,
    }),
    makeCat({
      key: "accessories_cap",
      parentKey: "accessories",
      nameHe: "גלימות",
      nameAr: "أغطية/مراييل",
      slug: "capes",
      sortOrder: 62,
      image: IMAGES.categories.accessories_cap,
    }),
  ];
}

function seedBrands() {
  return ["Wahl", "Andis", "BaBylissPRO", "Oster", "Moser", "Gamma+", "StyleCraft"];
}

function seedProducts({ catsByKey, brands }) {
  const catId = (k) => catsByKey.get(k)?._id;

  const base = [
    // ===== CLIPPERS =====
    {
      skuBase: "WAHL-MAGIC",
      nameHe: "Wahl Magic Clip אלחוטי",
      nameAr: "Wahl Magic Clip لاسلكي",
      descriptionHe: "מכונת תספורת אלחוטית מקצועית עם מנוע חזק וסוללה עמידה. מושלמת לפייד ותספורות מדויקות.",
      descriptionAr: "ماكينة قص احترافية لاسلكية بمحرك قوي وبطارية طويلة الأمد. مثالية للفيد والقصات الدقيقة.",
      brand: "Wahl",
      categoryIds: [catId("clippers_wireless")].filter(Boolean),
      images: IMAGES.products.wahlMagicClip,
      slug: "wahl-magic-clip",
      isActive: true,
      attributes: { type: "clipper", power: "wireless", motorType: "rotary", bladeMaterial: "stainless-steel" },
      variants: [
        { sku: "WAHL-MAGIC-STD", price: 499, currency: CURRENCY, options: { kit: "standard" }, stock: 25 },
        { sku: "WAHL-MAGIC-PRO", price: 549, currency: CURRENCY, options: { kit: "pro" }, stock: 18 },
      ],
    },
    {
      skuBase: "OSTER-76",
      nameHe: "Oster Classic 76 חוטי",
      nameAr: "Oster Classic 76 سلكي",
      descriptionHe: "מכונת תספורת קלאסית חזקה במיוחד, האהובה על ספרים מקצועיים ברחבי העולם.",
      descriptionAr: "ماكينة قص كلاسيكية قوية للغاية، المفضلة لدى الحلاقين المحترفين حول العالم.",
      brand: "Oster",
      categoryIds: [catId("clippers_wired")].filter(Boolean),
      images: IMAGES.products.osterClassic,
      slug: "oster-classic-76",
      isActive: true,
      attributes: { type: "clipper", power: "wired", motorType: "universal", bladeMaterial: "detachable" },
      variants: [
        { sku: "OSTER-76-BLK", price: 649, currency: CURRENCY, options: { color: "black" }, stock: 12 },
        { sku: "OSTER-76-SLV", price: 649, currency: CURRENCY, options: { color: "silver" }, stock: 8 },
      ],
    },
    {
      skuBase: "GAMMA-ERGO",
      nameHe: "Gamma+ Ergo אלחוטי",
      nameAr: "Gamma+ Ergo لاسلكي",
      descriptionHe: "מכונת תספורת ארגונומית עם עיצוב חדשני, קלה לאחיזה ועבודה ממושכת.",
      descriptionAr: "ماكينة قص مريحة بتصميم مبتكر، خفيفة للإمساك والعمل لفترات طويلة.",
      brand: "Gamma+",
      categoryIds: [catId("clippers_wireless")].filter(Boolean),
      images: IMAGES.products.gammaErgo,
      slug: "gamma-ergo-clipper",
      isActive: true,
      attributes: { type: "clipper", power: "wireless", motorType: "magnetic", bladeMaterial: "DLC" },
      variants: [
        { sku: "GAMMA-ERGO-BLK", price: 799, currency: CURRENCY, options: { color: "matte-black" }, stock: 15 },
        { sku: "GAMMA-ERGO-GLD", price: 849, currency: CURRENCY, options: { color: "gold" }, stock: 10 },
      ],
    },

    // ===== TRIMMERS =====
    {
      skuBase: "ANDIS-TL",
      nameHe: "Andis T-Outliner חוטי",
      nameAr: "Andis T-Outliner سلكي",
      descriptionHe: "טרימר דיוק עם להב T, אידאלי לקווים חדים ועיצוב זקן מקצועי.",
      descriptionAr: "تريمر دقة بشفرة T مثالي للرسم والحدود وتنسيق اللحية بشكل احترافي.",
      brand: "Andis",
      categoryIds: [catId("trimmers_zero")].filter(Boolean),
      images: IMAGES.products.andisTOutliner,
      slug: "andis-t-outliner",
      isActive: true,
      attributes: { type: "trimmer", blade: "T", power: "wired" },
      variants: [
        { sku: "ANDIS-TL-BLK", price: 429, currency: CURRENCY, options: { color: "black" }, stock: 20 },
        { sku: "ANDIS-TL-WHT", price: 429, currency: CURRENCY, options: { color: "white" }, stock: 15 },
      ],
    },
    {
      skuBase: "MOSER-CHROM",
      nameHe: "Moser ChroMini Pro",
      nameAr: "Moser ChroMini Pro",
      descriptionHe: "טרימר קומפקטי וחזק לדיוק מקסימלי, אידאלי לגימור ועיצוב.",
      descriptionAr: "تريمر صغير وقوي للدقة القصوى، مثالي للتشطيب والتصميم.",
      brand: "Moser",
      categoryIds: [catId("trimmers_zero")].filter(Boolean),
      images: IMAGES.products.moserChromini,
      slug: "moser-chromini-pro",
      isActive: true,
      attributes: { type: "trimmer", blade: "precision", power: "wireless" },
      variants: [{ sku: "MOSER-CHROM-STD", price: 349, currency: CURRENCY, options: { kit: "standard" }, stock: 30 }],
    },
    {
      skuBase: "NOSE-TRIM",
      nameHe: "טרימר אף ואוזניים מקצועי",
      nameAr: "تريمر أنف وأذن احترافي",
      descriptionHe: "טרימר קומפקטי לאף ואוזניים, עדין על העור ויעיל.",
      descriptionAr: "تريمر صغير للأنف والأذن، لطيف على البشرة وفعال.",
      brand: "Wahl",
      categoryIds: [catId("trimmers_nose")].filter(Boolean),
      images: IMAGES.products.noseTrimmer,
      slug: "nose-ear-trimmer-pro",
      isActive: true,
      attributes: { type: "trimmer", specialUse: "nose-ear" },
      variants: [{ sku: "NOSE-TRIM-STD", price: 79, currency: CURRENCY, options: { power: "battery" }, stock: 50 }],
    },

    // ===== SHAVERS =====
    {
      skuBase: "BABYLISS-FOIL",
      nameHe: "BaBylissPRO Foil Shaver",
      nameAr: "BaBylissPRO ماكينة حلاقة فويل",
      descriptionHe: "מכונת גילוח פויל מקצועית לגימור חלק ונקי, אידאלית לאחרי פייד.",
      descriptionAr: "ماكينة فويل احترافية لإنهاء ناعم ونظيف، مثالية بعد الفيد.",
      brand: "BaBylissPRO",
      categoryIds: [catId("shavers")].filter(Boolean),
      images: IMAGES.products.babylissFoil,
      slug: "babylisspro-foil-shaver",
      isActive: true,
      attributes: { type: "shaver", head: "foil", power: "wireless" },
      variants: [
        { sku: "BABYLISS-FOIL-GOLD", price: 399, currency: CURRENCY, options: { color: "gold" }, stock: 15 },
        { sku: "BABYLISS-FOIL-BLACK", price: 399, currency: CURRENCY, options: { color: "black" }, stock: 12 },
      ],
    },

    // ===== BLADES =====
    {
      skuBase: "BLADE-SET-1",
      nameHe: "סט סכינים אוניברסלי",
      nameAr: "طقم شفرات عالمي",
      descriptionHe: "סט סכינים חלופי איכותי למכונות נפוצות, כולל מידות שונות.",
      descriptionAr: "طقم شفرات بديلة عالية الجودة للماكينات الشائعة، يشمل أحجام مختلفة.",
      brand: "Wahl",
      categoryIds: [catId("blades")].filter(Boolean),
      images: IMAGES.products.bladeSet,
      slug: "universal-blade-set",
      isActive: true,
      attributes: { type: "blade", compatibility: "universal" },
      variants: [
        { sku: "BLADE-SET-8PC", price: 129, currency: CURRENCY, options: { pieces: "8" }, stock: 40 },
        { sku: "BLADE-SET-12PC", price: 179, currency: CURRENCY, options: { pieces: "12" }, stock: 25 },
      ],
    },

    // ===== CARE - OILS =====
    {
      skuBase: "OIL-ARGAN",
      nameHe: "שמן זקן ארגן פרימיום",
      nameAr: "زيت لحية أرجان بريميوم",
      descriptionHe: "שמן זקן טבעי מועשר בארגן להזנה, ברק ורכות מושלמת.",
      descriptionAr: "زيت لحية طبيعي غني بالأرجان للتغذية واللمعان والنعومة المثالية.",
      brand: "StyleCraft",
      categoryIds: [catId("care_oils")].filter(Boolean),
      images: IMAGES.products.beardOil,
      slug: "beard-oil-argan-premium",
      isActive: true,
      attributes: { type: "beard_oil", ingredients: ["argan", "jojoba", "vitamin-e"] },
      variants: [
        { sku: "OIL-ARGAN-30", price: 59, currency: CURRENCY, options: { size: "30ml" }, stock: 100 },
        { sku: "OIL-ARGAN-50", price: 79, currency: CURRENCY, options: { size: "50ml" }, stock: 70 },
        { sku: "OIL-ARGAN-100", price: 119, currency: CURRENCY, options: { size: "100ml" }, stock: 40 },
      ],
    },
    {
      skuBase: "CLIPPER-OIL",
      nameHe: "שמן למכונות תספורת",
      nameAr: "زيت لماكينات القص",
      descriptionHe: "שמן איכותי לתחזוקת מכונות תספורת וטרימרים, מאריך חיי הסכינים.",
      descriptionAr: "زيت عالي الجودة لصيانة ماكينات القص والتريمر، يطيل عمر الشفرات.",
      brand: "Wahl",
      categoryIds: [catId("care_oils")].filter(Boolean),
      images: IMAGES.products.clipperOil,
      slug: "clipper-maintenance-oil",
      isActive: true,
      attributes: { type: "maintenance_oil", use: "clippers" },
      variants: [{ sku: "CLIP-OIL-118", price: 35, currency: CURRENCY, options: { size: "118ml" }, stock: 80 }],
    },

    // ===== CARE - BALMS =====
    {
      skuBase: "BALM-CEDAR",
      nameHe: "בלם זקן ארז וסנדלווד",
      nameAr: "بلسم لحية خشب الأرز والصندل",
      descriptionHe: "בלם זקן טבעי בניחוח גברי של ארז וסנדלווד, מעניק עיצוב ולחות.",
      descriptionAr: "بلسم لحية طبيعي برائحة رجالية من خشب الأرز والصندل، يمنح التصميم والترطيب.",
      brand: "StyleCraft",
      categoryIds: [catId("care_balms")].filter(Boolean),
      images: IMAGES.products.beardBalm,
      slug: "beard-balm-cedar-sandalwood",
      isActive: true,
      attributes: { type: "beard_balm", scent: "cedar-sandalwood" },
      variants: [{ sku: "BALM-CEDAR-60", price: 69, currency: CURRENCY, options: { size: "60g" }, stock: 60 }],
    },

    // ===== ACCESSORIES - COMBS =====
    {
      skuBase: "COMB-CARBON",
      nameHe: "מסרק קרבון מקצועי",
      nameAr: "مشط كربون احترافي",
      descriptionHe: "מסרק עמיד לחום מקרבון, נוח לאחיזה ומושלם לעיצוב וסירוק.",
      descriptionAr: "مشط كربون مقاوم للحرارة ومريح، مثالي للتصميم والتسريح.",
      brand: "Gamma+",
      categoryIds: [catId("accessories_combs")].filter(Boolean),
      images: IMAGES.products.carbonComb,
      slug: "pro-carbon-comb",
      isActive: true,
      attributes: { type: "comb", material: "carbon", heatResistant: true },
      variants: [
        { sku: "COMB-CARBON-STD", price: 29, currency: CURRENCY, options: { size: "standard" }, stock: 150 },
        { sku: "COMB-CARBON-WIDE", price: 35, currency: CURRENCY, options: { size: "wide-tooth" }, stock: 100 },
      ],
    },
    {
      skuBase: "BRUSH-STYLE",
      nameHe: "מברשת עיצוב מקצועית",
      nameAr: "فرشاة تصفيف احترافية",
      descriptionHe: "מברשת עיצוב עגולה עם שיער טבעי, אידאלית ליצירת נפח ועיצוב.",
      descriptionAr: "فرشاة تصفيف دائرية بشعر طبيعي، مثالية لإنشاء الحجم والتصميم.",
      brand: "BaBylissPRO",
      categoryIds: [catId("accessories_combs")].filter(Boolean),
      images: IMAGES.products.stylingBrush,
      slug: "pro-styling-brush",
      isActive: true,
      attributes: { type: "brush", bristles: "natural", shape: "round" },
      variants: [
        { sku: "BRUSH-STYLE-SM", price: 49, currency: CURRENCY, options: { size: "small" }, stock: 45 },
        { sku: "BRUSH-STYLE-MD", price: 59, currency: CURRENCY, options: { size: "medium" }, stock: 60 },
        { sku: "BRUSH-STYLE-LG", price: 69, currency: CURRENCY, options: { size: "large" }, stock: 35 },
      ],
    },

    // ===== ACCESSORIES - CAPES =====
    {
      skuBase: "CAPE-PRO",
      nameHe: "גלימת ספר מקצועית",
      nameAr: "مريول حلاقة احترافي",
      descriptionHe: "גלימה מקצועית עמידה למים עם סגירת צוואר מתכווננת.",
      descriptionAr: "مريول احترافي مقاوم للماء مع إغلاق رقبة قابل للتعديل.",
      brand: "StyleCraft",
      categoryIds: [catId("accessories_cap")].filter(Boolean),
      images: IMAGES.products.barberCape,
      slug: "professional-barber-cape",
      isActive: true,
      attributes: { type: "cape", waterproof: true, closure: "adjustable-snap" },
      variants: [
        { sku: "CAPE-PRO-BLK", price: 89, currency: CURRENCY, options: { color: "black" }, stock: 40 },
        { sku: "CAPE-PRO-WHT", price: 89, currency: CURRENCY, options: { color: "white" }, stock: 30 },
        { sku: "CAPE-PRO-RED", price: 99, currency: CURRENCY, options: { color: "red" }, stock: 20 },
      ],
    },
  ];

  // ✅ ensure mix true/false + keep variants consistent
  return withStockFlag(base);
}

function seedCoupons() {
  // Store minor units in DB for fixed/min order totals.
  const welcomeMin = money(150);
  const freeShipMin = money(250);
  const barberMin = money(300);
  const freeShipValue = money(30);

  return [
    {
      code: "WELCOME10",
      type: "percent",
      value: 10,
      currency: CURRENCY,
      minOrderTotal: welcomeMin,
      // extra compatibility with newer validator/controller (ignored if not in schema)
      minOrderTotalMinor: welcomeMin,
      maxUsesTotal: 200,
      usesTotal: 0,
      startsAt: now(),
      endsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 90),
      isActive: true,
    },
    {
      code: "FREESHIP",
      type: "fixed",
      value: freeShipValue, // minor
      valueMinor: freeShipValue, // extra compatibility
      currency: CURRENCY,
      minOrderTotal: freeShipMin, // minor
      minOrderTotalMinor: freeShipMin,
      maxUsesTotal: 500,
      usesTotal: 0,
      startsAt: now(),
      endsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 120),
      isActive: true,
    },
    {
      code: "BARBER20",
      type: "percent",
      value: 20,
      currency: CURRENCY,
      minOrderTotal: barberMin, // minor
      minOrderTotalMinor: barberMin,
      maxUsesTotal: 100,
      usesTotal: 0,
      startsAt: now(),
      endsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 60),
      isActive: true,
    },
  ];
}

function seedShippingMethods() {
  // Requirement: free shipping above 300₪
  return [
    {
      code: "pickup",
      name: "Pickup",
      nameHe: "איסוף עצמי",
      nameAr: "استلام ذاتي",
      basePrice: money(0),
      freeAbove: null,
      isActive: true,
      currency: CURRENCY, // safe if schema supports; ignored otherwise
    },
    {
      code: "standard",
      name: "Standard Delivery",
      nameHe: "משלוח רגיל",
      nameAr: "توصيل عادي",
      basePrice: money(25),
      freeAbove: money(300), // ✅ free shipping above 300₪
      isActive: true,
      currency: CURRENCY,
    },
    {
      code: "express",
      name: "Express Delivery",
      nameHe: "משלוח מהיר",
      nameAr: "توصيل سريع",
      basePrice: money(45),
      freeAbove: money(300), // ✅ change to money(400) if you want express to be different
      isActive: true,
      currency: CURRENCY,
    },
  ];
}

// ---- Main ----
async function main() {
  assertConfirmWipe();
  await connectDb();
  console.log("✅ Mongo connected");

  const optional = await loadOptionalModels();

  console.log("🧨 WIPING ALL DATA...");
  await safeDeleteMany(optional.get("StripeEvent"), "StripeEvent");
  await safeDeleteMany(optional.get("Invoice"), "Invoice");
  await safeDeleteMany(optional.get("RefundRequest"), "RefundRequest");
  await safeDeleteMany(optional.get("CouponRedemption"), "CouponRedemption");
  await safeDeleteMany(optional.get("StockLog"), "StockLog");
  await safeDeleteMany(optional.get("StockReservation"), "StockReservation");
  await safeDeleteMany(optional.get("Review"), "Review");
  await safeDeleteMany(optional.get("Wishlist"), "Wishlist");
  await safeDeleteMany(optional.get("Cart"), "Cart");
  await safeDeleteMany(optional.get("Order"), "Order");

  await safeDeleteMany(optional.get("IdempotencyRecord"), "IdempotencyRecord");
  await safeDeleteMany(optional.get("RateLimitBucket"), "RateLimitBucket");
  await safeDeleteMany(optional.get("Job"), "Job");
  await safeDeleteMany(optional.get("LeaseLock"), "LeaseLock");
  await safeDeleteMany(optional.get("AuditLog"), "AuditLog");
  await safeDeleteMany(optional.get("AlertLog"), "AlertLog");
  await safeDeleteMany(optional.get("FeatureFlag"), "FeatureFlag");
  await safeDeleteMany(optional.get("ReadModel"), "ReadModel");

  await safeDeleteMany(Variant, "Variant");
  await safeDeleteMany(Product, "Product");
  await safeDeleteMany(Category, "Category");
  await safeDeleteMany(Coupon, "Coupon");
  await safeDeleteMany(ShippingMethod, "ShippingMethod");
  await safeDeleteMany(User, "User");

  console.log("✅ DB wiped");

  // Seed categories
  const catsInput = seedCategories();
  const catsByKey = await insertCategoriesTree(catsInput);
  console.log(`✅ Categories inserted: ${catsByKey.size}`);

  // Seed shipping
  if (ShippingMethod) {
    try {
      const sm = seedShippingMethods();
      await ShippingMethod.insertMany(sm, { ordered: true });
      console.log(`✅ ShippingMethods inserted: ${sm.length}`);
    } catch (e) {
      console.warn("⚠️ ShippingMethods insert failed (schema mismatch?).", e?.message || e);
    }
  }

  // Seed coupons
  if (Coupon) {
    try {
      const cps = seedCoupons();
      await Coupon.insertMany(cps, { ordered: true });
      console.log(`✅ Coupons inserted: ${cps.length}`);
    } catch (e) {
      console.warn("⚠️ Coupons insert failed (schema mismatch?).", e?.message || e);
    }
  }

  // Seed products + variants
  const brands = seedBrands();
  const products = seedProducts({ catsByKey, brands });

  const createdProducts = [];
  for (const p of products) {
    const prod = await Product.create({
      nameHe: p.nameHe,
      nameAr: p.nameAr,
      descriptionHe: p.descriptionHe,
      descriptionAr: p.descriptionAr,
      brand: p.brand,
      categoryIds: p.categoryIds,
      images: p.images,
      slug: p.slug,
      isActive: p.isActive,
      attributes: p.attributes ?? {},

      // ✅ NEW: inStock mix (true/false)
      inStock: typeof p.inStock === "boolean" ? p.inStock : true,

      // currency in DB should be ISO, not a symbol
      currency: CURRENCY,
    });

    createdProducts.push(prod);

    // ✅ IMPORTANT: write BOTH "available" and "stock" to avoid schema mismatch
    const variantsDocs = (p.variants ?? []).map((v) => {
      const qty = Number(v.stock ?? 0);
      return {
        productId: prod._id,
        sku: v.sku,
        price: money(v.price), // store as minor integer
        currency: v.currency || CURRENCY, // ISO code
        options: v.options ?? {},

        // compatibility fields (some schemas use one of them)
        available: qty,
        stock: qty,
        stockReserved: 0,

        isActive: true,
      };
    });

    if (variantsDocs.length) {
      await Variant.insertMany(variantsDocs, { ordered: true });
    }
  }

  console.log(`✅ Products inserted: ${createdProducts.length}`);
  console.log(`✅ Variants inserted: ${products.reduce((a, p) => a + (p.variants?.length || 0), 0)}`);

  // Seed admin user
  const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@local.test";
  const adminPass = process.env.SEED_ADMIN_PASSWORD || "Admin12345!";
  const passwordHash = await bcrypt.hash(adminPass, 10);

  try {
    await User.create({
      email: adminEmail,
      emailLower: String(adminEmail).toLowerCase(),
      passwordHash,
      roles: ["admin"],
      isActive: true,
    });

    console.log("✅ Admin user created:");
    console.log("   email:", adminEmail);
    console.log("   password:", adminPass);
  } catch (e) {
    console.warn("⚠️ Admin user insert failed (schema mismatch?).", e?.message || e);
  }

  console.log("🎉 SEED DONE");
  console.log("");
  console.log("📊 Summary:");
  console.log(`   - ${catsByKey.size} categories (with images)`);
  console.log(`   - ${createdProducts.length} products`);
  console.log(`   - ${products.reduce((a, p) => a + (p.variants?.length || 0), 0)} variants`);
  console.log(`   - 3 coupons`);
  console.log(`   - 3 shipping methods`);
}

main()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ Seed failed:", err);
    try {
      await mongoose.disconnect();
    } catch {}
    process.exit(1);
  });
