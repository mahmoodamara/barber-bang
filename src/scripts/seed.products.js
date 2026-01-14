// src/scripts/seed.products.js
// Idempotent seed script - safe to re-run (uses bulkWrite upserts)
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

// ISO 4217 currency code (NOT symbol)
const CURRENCY = "ILS";

// money() returns minor units (agorot) for DB storage
function money(majorUnits) {
  return toMinorUnits(majorUnits, CURRENCY);
}

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
 * Build category tree and upsert using bulkWrite.
 * Upserts by fullSlug (unique index).
 */
async function upsertCategoriesTree(categoriesInput) {
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

    const filter = { fullSlug };
    const update = {
      $set: {
        nameHe: c.nameHe,
        nameAr: c.nameAr,
        slug: c.slug,
        fullSlug,
        parentId: parent?._id ?? null,
        ancestors,
        level,
        sortOrder: c.sortOrder ?? 0,
        isActive: c.isActive ?? true,
        image: c.image ?? "",
        isDeleted: false,
        deletedAt: null,
      },
      $setOnInsert: {
        createdAt: now(),
      },
    };

    const result = await Category.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });

    insertedByKey.set(c.key, result);
  }

  return insertedByKey;
}

/**
 * Upsert products by slug (unique index).
 * Returns Map<slug, Product>
 */
async function upsertProducts(products) {
  const productsBySlug = new Map();

  for (const p of products) {
    const filter = { slug: p.slug, isDeleted: { $ne: true } };
    const update = {
      $set: {
        nameHe: p.nameHe,
        nameAr: p.nameAr,
        descriptionHe: p.descriptionHe,
        descriptionAr: p.descriptionAr,
        brand: p.brand,
        categoryIds: p.categoryIds,
        images: p.images,
        slug: p.slug,
        isActive: p.isActive ?? true,
        inStock: p.inStock ?? true,
        attributes: p.attributes ?? {},
        isDeleted: false,
        deletedAt: null,
      },
      $setOnInsert: {
        reviewsCount: 0,
        ratingAvg: null,
        createdAt: now(),
      },
    };

    const result = await Product.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });

    productsBySlug.set(p.slug, { doc: result, variants: p.variants ?? [] });
  }

  return productsBySlug;
}

/**
 * Upsert variants by sku (unique index).
 */
async function upsertVariants(productsBySlug) {
  const ops = [];

  for (const [slug, { doc, variants }] of productsBySlug) {
    for (const v of variants) {
      ops.push({
        updateOne: {
          filter: { sku: v.sku, isDeleted: { $ne: true } },
          update: {
            $set: {
              productId: doc._id,
              sku: v.sku,
              barcode: v.barcode || null,
              price: money(v.price),
              currency: v.currency || CURRENCY,
              stock: v.stock ?? 0,
              stockReserved: 0,
              options: v.options ?? {},
              isActive: true,
              sortOrder: v.sortOrder ?? 0,
              isDeleted: false,
              deletedAt: null,
            },
            $setOnInsert: {
              createdAt: now(),
            },
          },
          upsert: true,
        },
      });
    }
  }

  if (ops.length > 0) {
    await Variant.bulkWrite(ops, { ordered: false });
  }

  return ops.length;
}

/**
 * Upsert coupons by code (unique index).
 */
async function upsertCoupons(coupons) {
  if (!Coupon) return 0;

  const ops = coupons.map((c) => ({
    updateOne: {
      filter: { code: c.code.toUpperCase() },
      update: {
        $set: {
          code: c.code.toUpperCase(),
          type: c.type,
          value: c.value,
          currency: c.currency || CURRENCY,
          minOrderTotal: c.minOrderTotal ?? 0,
          maxUsesTotal: c.maxUsesTotal ?? null,
          maxUsesPerUser: c.maxUsesPerUser ?? null,
          allowedUserIds: c.allowedUserIds ?? [],
          allowedRoles: c.allowedRoles ?? [],
          startsAt: c.startsAt ?? null,
          endsAt: c.endsAt ?? null,
          isActive: c.isActive ?? true,
        },
        $setOnInsert: {
          usesTotal: 0,
          createdAt: now(),
        },
      },
      upsert: true,
    },
  }));

  if (ops.length > 0) {
    await Coupon.bulkWrite(ops, { ordered: false });
  }

  return ops.length;
}

/**
 * Upsert shipping methods by code (unique index).
 * Schema fields: code, nameHe, nameAr, descHe, descAr, basePrice, freeAbove, minSubtotal, maxSubtotal, cities, sort, isActive
 */
async function upsertShippingMethods(methods) {
  if (!ShippingMethod) {
    console.warn("⚠️ ShippingMethod model not loaded, skipping");
    return 0;
  }

  // Use findOneAndUpdate for each to ensure proper upsert behavior
  for (const m of methods) {
    const filter = { code: m.code.toUpperCase() };
    const update = {
      $set: {
        code: m.code.toUpperCase(),
        nameHe: m.nameHe,
        nameAr: m.nameAr,
        descHe: m.descHe ?? "",
        descAr: m.descAr ?? "",
        basePrice: m.basePrice ?? 0,
        freeAbove: m.freeAbove ?? null,
        minSubtotal: m.minSubtotal ?? null,
        maxSubtotal: m.maxSubtotal ?? null,
        cities: m.cities ?? [],
        sort: m.sort ?? 100,
        isActive: m.isActive ?? true,
      },
      $setOnInsert: {
        createdAt: now(),
      },
    };

    await ShippingMethod.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
  }

  return methods.length;
}

/**
 * Upsert admin user by emailLower (unique sparse index).
 */
async function upsertAdminUser(email, password) {
  const emailLower = String(email).toLowerCase().trim();
  const passwordHash = await bcrypt.hash(password, 10);

  const filter = { emailLower };
  const update = {
    $set: {
      email: email.trim(),
      emailLower,
      passwordHash,
      roles: ["admin"],
      isActive: true,
    },
    $setOnInsert: {
      addresses: [],
      segments: [],
      permissions: [],
      tokenVersion: 0,
      emailVerified: false,
      failedLoginCount: 0,
      loginAttempts: 0,
      createdAt: now(),
    },
  };

  await User.findOneAndUpdate(filter, update, {
    upsert: true,
    setDefaultsOnInsert: true,
  });

  return emailLower;
}

// =====================================================
// 🖼️ IMAGE COLLECTIONS - Professional Barber Equipment
// =====================================================

const IMAGES = {
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
  products: {
    wahlMagicClip: [
      "https://images.unsplash.com/photo-1621607512022-6aecc4fed814?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1582095133179-bfd08e2fc6b3?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    ],
    andisTOutliner: [
      "https://images.unsplash.com/photo-1621605815971-fbc98d665033?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1599351431202-1e0f0137899a?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1622286342621-4bd786c2447c?w=800&h=600&fit=crop&q=80",
    ],
    babylissFoil: [
      "https://images.unsplash.com/photo-1621607505837-4c5fe8a63d63?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1626808642875-0aa545482dfb?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=800&h=600&fit=crop&q=80",
    ],
    bladeSet: [
      "https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1621607512022-6aecc4fed814?w=800&h=600&fit=crop&q=80",
    ],
    beardOil: [
      "https://images.unsplash.com/photo-1598524374912-6b0b0bdb9dd6?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1608248597279-f99d160bfcbc?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1626808642875-0aa545482dfb?w=800&h=600&fit=crop&q=80",
    ],
    carbonComb: [
      "https://images.unsplash.com/photo-1527799820374-dcf8d9d4a388?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    ],
    osterClassic: [
      "https://images.unsplash.com/photo-1582095133179-bfd08e2fc6b3?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1621607512022-6aecc4fed814?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    ],
    moserChromini: [
      "https://images.unsplash.com/photo-1599351431202-1e0f0137899a?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1621605815971-fbc98d665033?w=800&h=600&fit=crop&q=80",
    ],
    gammaErgo: [
      "https://images.unsplash.com/photo-1621607512022-6aecc4fed814?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1582095133179-bfd08e2fc6b3?w=800&h=600&fit=crop&q=80",
    ],
    noseTrimmer: [
      "https://images.unsplash.com/photo-1626808642875-0aa545482dfb?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1621605815971-fbc98d665033?w=800&h=600&fit=crop&q=80",
    ],
    beardBalm: [
      "https://images.unsplash.com/photo-1608248597279-f99d160bfcbc?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1598524374912-6b0b0bdb9dd6?w=800&h=600&fit=crop&q=80",
    ],
    barberCape: [
      "https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    ],
    clipperOil: [
      "https://images.unsplash.com/photo-1598524374912-6b0b0bdb9dd6?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1621607512022-6aecc4fed814?w=800&h=600&fit=crop&q=80",
    ],
    stylingBrush: [
      "https://images.unsplash.com/photo-1527799820374-dcf8d9d4a388?w=800&h=600&fit=crop&q=80",
      "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&h=600&fit=crop&q=80",
    ],
  },
};

// ---- Seed Data Generators ----
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

/**
 * Deterministic inStock mix: every 3rd product is out of stock.
 */
function withStockFlag(products) {
  return products.map((p, i) => {
    const inStock = i % 3 !== 0;
    const variants = (p.variants ?? []).map((v) => {
      const baseQty = Number(v.stock ?? 0);
      return { ...v, stock: inStock ? Math.max(0, baseQty) : 0 };
    });
    return { ...p, inStock, variants };
  });
}

function seedProducts({ catsByKey }) {
  const catId = (k) => catsByKey.get(k)?._id;

  const base = [
    // ===== CLIPPERS =====
    {
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
        { sku: "WAHL-MAGIC-STD", price: 499, options: { kit: "standard" }, stock: 25 },
        { sku: "WAHL-MAGIC-PRO", price: 549, options: { kit: "pro" }, stock: 18 },
      ],
    },
    {
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
        { sku: "OSTER-76-BLK", price: 649, options: { color: "black" }, stock: 12 },
        { sku: "OSTER-76-SLV", price: 649, options: { color: "silver" }, stock: 8 },
      ],
    },
    {
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
        { sku: "GAMMA-ERGO-BLK", price: 799, options: { color: "matte-black" }, stock: 15 },
        { sku: "GAMMA-ERGO-GLD", price: 849, options: { color: "gold" }, stock: 10 },
      ],
    },

    // ===== TRIMMERS =====
    {
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
        { sku: "ANDIS-TL-BLK", price: 429, options: { color: "black" }, stock: 20 },
        { sku: "ANDIS-TL-WHT", price: 429, options: { color: "white" }, stock: 15 },
      ],
    },
    {
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
      variants: [{ sku: "MOSER-CHROM-STD", price: 349, options: { kit: "standard" }, stock: 30 }],
    },
    {
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
      variants: [{ sku: "NOSE-TRIM-STD", price: 79, options: { power: "battery" }, stock: 50 }],
    },

    // ===== SHAVERS =====
    {
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
        { sku: "BABYLISS-FOIL-GOLD", price: 399, options: { color: "gold" }, stock: 15 },
        { sku: "BABYLISS-FOIL-BLACK", price: 399, options: { color: "black" }, stock: 12 },
      ],
    },

    // ===== BLADES =====
    {
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
        { sku: "BLADE-SET-8PC", price: 129, options: { pieces: "8" }, stock: 40 },
        { sku: "BLADE-SET-12PC", price: 179, options: { pieces: "12" }, stock: 25 },
      ],
    },

    // ===== CARE - OILS =====
    {
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
        { sku: "OIL-ARGAN-30", price: 59, options: { size: "30ml" }, stock: 100 },
        { sku: "OIL-ARGAN-50", price: 79, options: { size: "50ml" }, stock: 70 },
        { sku: "OIL-ARGAN-100", price: 119, options: { size: "100ml" }, stock: 40 },
      ],
    },
    {
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
      variants: [{ sku: "CLIP-OIL-118", price: 35, options: { size: "118ml" }, stock: 80 }],
    },

    // ===== CARE - BALMS =====
    {
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
      variants: [{ sku: "BALM-CEDAR-60", price: 69, options: { size: "60g" }, stock: 60 }],
    },

    // ===== ACCESSORIES - COMBS =====
    {
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
        { sku: "COMB-CARBON-STD", price: 29, options: { size: "standard" }, stock: 150 },
        { sku: "COMB-CARBON-WIDE", price: 35, options: { size: "wide-tooth" }, stock: 100 },
      ],
    },
    {
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
        { sku: "BRUSH-STYLE-SM", price: 49, options: { size: "small" }, stock: 45 },
        { sku: "BRUSH-STYLE-MD", price: 59, options: { size: "medium" }, stock: 60 },
        { sku: "BRUSH-STYLE-LG", price: 69, options: { size: "large" }, stock: 35 },
      ],
    },

    // ===== ACCESSORIES - CAPES =====
    {
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
        { sku: "CAPE-PRO-BLK", price: 89, options: { color: "black" }, stock: 40 },
        { sku: "CAPE-PRO-WHT", price: 89, options: { color: "white" }, stock: 30 },
        { sku: "CAPE-PRO-RED", price: 99, options: { color: "red" }, stock: 20 },
      ],
    },
  ];

  return withStockFlag(base);
}

/**
 * Coupon data - all money values in minor units (agorot).
 * Schema fields: code, type, value, currency, minOrderTotal, maxUsesTotal, usesTotal,
 *                maxUsesPerUser, allowedUserIds, allowedRoles, startsAt, endsAt, isActive
 */
function seedCoupons() {
  return [
    {
      code: "WELCOME10",
      type: "percent",
      value: 10, // 10%
      currency: CURRENCY,
      minOrderTotal: money(150), // min 150₪
      maxUsesTotal: 200,
      maxUsesPerUser: 1,
      startsAt: now(),
      endsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 90), // 90 days
      isActive: true,
    },
    {
      code: "FREESHIP",
      type: "fixed",
      value: money(30), // 30₪ discount (minor units)
      currency: CURRENCY,
      minOrderTotal: money(250), // min 250₪
      maxUsesTotal: 500,
      maxUsesPerUser: null,
      startsAt: now(),
      endsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 120), // 120 days
      isActive: true,
    },
    {
      code: "BARBER20",
      type: "percent",
      value: 20, // 20%
      currency: CURRENCY,
      minOrderTotal: money(300), // min 300₪
      maxUsesTotal: 100,
      maxUsesPerUser: 2,
      startsAt: now(),
      endsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 60), // 60 days
      isActive: true,
    },
  ];
}

/**
 * Shipping methods data.
 * Schema fields: code, nameHe, nameAr, descHe, descAr, basePrice, freeAbove,
 *                minSubtotal, maxSubtotal, cities, sort, isActive
 */
function seedShippingMethods() {
  return [
    {
      code: "SELF_PICKUP",
      nameHe: "איסוף עצמי",
      nameAr: "استلام ذاتي",
      descHe: "איסוף מהחנות ללא עלות",
      descAr: "استلام من المتجر بدون تكلفة",
      basePrice: 0,
      freeAbove: null,
      sort: 10,
      isActive: true,
    },
    {
      code: "STANDARD",
      nameHe: "משלוח רגיל",
      nameAr: "توصيل عادي",
      descHe: "משלוח תוך 3-5 ימי עסקים",
      descAr: "التوصيل خلال 3-5 أيام عمل",
      basePrice: money(25), // 25₪
      freeAbove: money(300), // free above 300₪
      sort: 20,
      isActive: true,
    },
    {
      code: "EXPRESS",
      nameHe: "משלוח מהיר",
      nameAr: "توصيل سريع",
      descHe: "משלוח תוך 1-2 ימי עסקים",
      descAr: "التوصيل خلال 1-2 أيام عمل",
      basePrice: money(45), // 45₪
      freeAbove: money(500), // free above 500₪
      sort: 30,
      isActive: true,
    },
  ];
}

// ---- Main ----
async function main() {
  await connectDb();
  console.log("✅ Mongo connected");

  // 1. Upsert categories
  const catsInput = seedCategories();
  const catsByKey = await upsertCategoriesTree(catsInput);
  console.log(`✅ Categories upserted: ${catsByKey.size}`);

  // 2. Upsert shipping methods
  const shippingCount = await upsertShippingMethods(seedShippingMethods());
  console.log(`✅ ShippingMethods upserted: ${shippingCount}`);

  // 3. Upsert coupons
  const couponCount = await upsertCoupons(seedCoupons());
  console.log(`✅ Coupons upserted: ${couponCount}`);

  // 4. Upsert products
  const products = seedProducts({ catsByKey });
  const productsBySlug = await upsertProducts(products);
  console.log(`✅ Products upserted: ${productsBySlug.size}`);

  // 5. Upsert variants
  const variantCount = await upsertVariants(productsBySlug);
  console.log(`✅ Variants upserted: ${variantCount}`);

  // 6. Upsert admin user
  const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@local.test";
  const adminPass = process.env.SEED_ADMIN_PASSWORD || "Admin12345!";
  const adminCreated = await upsertAdminUser(adminEmail, adminPass);
  console.log("✅ Admin user upserted:", adminCreated);

  console.log("");
  console.log("🎉 SEED COMPLETE (idempotent - safe to re-run)");
  console.log("");
  console.log("📊 Summary:");
  console.log(`   - ${catsByKey.size} categories`);
  console.log(`   - ${productsBySlug.size} products`);
  console.log(`   - ${variantCount} variants`);
  console.log(`   - ${couponCount} coupons`);
  console.log(`   - ${shippingCount} shipping methods`);
  console.log(`   - 1 admin user (${adminEmail})`);
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
