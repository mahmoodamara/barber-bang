// src/scripts/seed.js
// Seed script for Simple Shop v2/v3 (HE/AR + offers + shipping + checkout truth)
// ✅ Safe to re-run (idempotent): uses upserts
// ✅ Compatible with new server contract:
// - Sale rule: salePrice exists AND salePrice < price + date window
// - Shipping: DeliveryArea + PickupPoint + StorePickupConfig
// - Pricing truth: quotePricing (campaign/coupon/offer/gifts)
// - Reviews (single comment field)
// - Content pages

import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

import { connectDB } from "../config/db.js";

import { User } from "../models/User.js";
import { Category } from "../models/Category.js";
import { Product } from "../models/Product.js";
import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { StorePickupConfig } from "../models/StorePickupConfig.js";
import { Coupon } from "../models/Coupon.js";
import { Campaign } from "../models/Campaign.js";
import { Gift } from "../models/Gift.js";
import { Offer } from "../models/Offer.js";

// ✅ NEW (per prompt)
import { ContentPage } from "../models/ContentPage.js";
import { Review } from "../models/Review.js";

/* =========================
   Helpers
========================= */

function nowPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

async function upsertByFilter(Model, filter, doc) {
  return Model.findOneAndUpdate(filter, { $set: doc }, { upsert: true, new: true });
}

// Major units rounding (2 decimals) - consistent with ILS
function roundMoney(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

// Compute salePrice from discountPercent when salePrice not provided
// ✅ Ensures new onSale rule works
function deriveSalePriceFromDiscount(price, discountPercent) {
  const p = Number(price || 0);
  const pct = Number(discountPercent || 0);
  if (!(p > 0)) return null;
  if (!(pct > 0 && pct < 100)) return null;

  const sale = roundMoney(p * (1 - pct / 100));
  if (!(sale < p)) return null;
  return sale;
}

function normalizeProductDoc(p) {
  const doc = { ...p };

  // legacy sync
  doc.title = doc.titleHe || doc.title || "";
  doc.description = doc.descriptionHe || doc.description || "";

  // defaults
  doc.isActive = doc.isActive ?? true;
  doc.isFeatured = Boolean(doc.isFeatured);
  doc.isBestSeller = Boolean(doc.isBestSeller);

  // ✅ Sale compatibility:
  // Server rule uses salePrice, not discountPercent.
  // If discountPercent exists but salePrice is missing, derive salePrice.
  if (doc.salePrice == null && doc.discountPercent != null) {
    const derived = deriveSalePriceFromDiscount(doc.price, doc.discountPercent);
    if (derived != null) doc.salePrice = derived;
  }

  // ✅ enforce rule: salePrice must be < price
  if (doc.salePrice != null) {
    const sp = Number(doc.salePrice);
    const pr = Number(doc.price);
    if (!(sp < pr)) {
      // If invalid, remove salePrice so it doesn't break validations / onSale logic
      doc.salePrice = null;
    }
  }

  // clean optional sale fields
  if (doc.salePrice === undefined) delete doc.salePrice;
  if (doc.discountPercent === undefined) delete doc.discountPercent;

  if (doc.saleStartAt === undefined) delete doc.saleStartAt;
  if (doc.saleEndAt === undefined) delete doc.saleEndAt;

  // normalize possible null dates
  if (doc.saleStartAt === null) delete doc.saleStartAt;
  if (doc.saleEndAt === null) delete doc.saleEndAt;

  return doc;
}

/* =========================
   Main
========================= */

async function main() {
  await connectDB();

  // Optional: speed up seed runs
  mongoose.set("strictQuery", true);

  /* -------------------------
     1) Admin user
  ------------------------- */
  const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@shop.local";
  const adminPass = process.env.SEED_ADMIN_PASSWORD || "Admin123!";
  const adminName = process.env.SEED_ADMIN_NAME || "Admin";

  const adminHash = await bcrypt.hash(adminPass, 10);
  const adminUser = await upsertByFilter(
    User,
    { email: adminEmail },
    {
      name: adminName,
      email: adminEmail,
      passwordHash: adminHash,
      role: "admin",
    },
  );

  /* -------------------------
     2) Test user (wishlist + reviews)
  ------------------------- */
  const testEmail = process.env.SEED_TEST_EMAIL || "test@shop.local";
  const testPass = process.env.SEED_TEST_PASSWORD || "Test123!";
  const testName = process.env.SEED_TEST_NAME || "Test User";

  const testHash = await bcrypt.hash(testPass, 10);
  const testUser = await upsertByFilter(
    User,
    { email: testEmail },
    {
      name: testName,
      email: testEmail,
      passwordHash: testHash,
      role: "user",
      cart: [],
      wishlist: [],
    },
  );

  /* -------------------------
     3) Categories (bilingual)
     Ensure Category has: nameHe,nameAr,name,slug
  ------------------------- */
  const categoryDocs = [
    { key: "CLIPPERS", nameHe: "מכונות תספורת", nameAr: "ماكينات حلاقة", slug: "clippers" },
    { key: "TRIMMERS", nameHe: "טרימרים", nameAr: "مشذبات", slug: "trimmers" },
    { key: "SHAVING", nameHe: "גילוח", nameAr: "حلاقة", slug: "shaving" },
    { key: "HAIR_CARE", nameHe: "טיפוח שיער", nameAr: "عناية بالشعر", slug: "hair-care" },
    { key: "ACCESSORIES", nameHe: "אביזרים", nameAr: "إكسسوارات", slug: "accessories" },
  ];

  const categories = [];
  for (const c of categoryDocs) {
    const saved = await upsertByFilter(
      Category,
      { slug: c.slug },
      {
        nameHe: c.nameHe,
        nameAr: c.nameAr,
        name: c.nameHe, // legacy
        slug: c.slug,
        isActive: true,
      },
    );
    categories.push(saved);
  }

  const catByKey = new Map(
    categoryDocs.map((c) => [c.key, categories.find((x) => x.slug === c.slug)]),
  );

  /* -------------------------
     4) Products (bilingual)
     ✅ Compatible with new sale rule
  ------------------------- */
  const img = {
    clipper:
      "https://images.unsplash.com/photo-1598514982844-6e2d3a9d4f5d?auto=format&fit=crop&w=1200&q=80",
    trimmer:
      "https://images.unsplash.com/photo-1621609764095-5b6f0a2b3b2f?auto=format&fit=crop&w=1200&q=80",
    razor:
      "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=1200&q=80",
    gel: "https://images.unsplash.com/photo-1556228453-efd6c1ff04f6?auto=format&fit=crop&w=1200&q=80",
    wax: "https://images.unsplash.com/photo-1617897903246-719ef07d2c8e?auto=format&fit=crop&w=1200&q=80",
    brush:
      "https://images.unsplash.com/photo-1598515214234-9c246b1d4d1e?auto=format&fit=crop&w=1200&q=80",
    cape: "https://images.unsplash.com/photo-1582095133179-bfd08e2fc6b3?auto=format&fit=crop&w=1200&q=80",
    scissors:
      "https://images.unsplash.com/photo-1589987607627-616cac5df0f2?auto=format&fit=crop&w=1200&q=80",
    comb: "https://images.unsplash.com/photo-1597861405049-2c0d646b0924?auto=format&fit=crop&w=1200&q=80",
    oil: "https://images.unsplash.com/photo-1611930022013-7b4d4b8d7b5a?auto=format&fit=crop&w=1200&q=80",
    disinfect:
      "https://images.unsplash.com/photo-1583946099379-f9c9cb8bc030?auto=format&fit=crop&w=1200&q=80",
    shampoo:
      "https://images.unsplash.com/photo-1615397349754-cfa2060a1c5d?auto=format&fit=crop&w=1200&q=80",
  };

  const productDocs = [
    {
      titleHe: "Wahl Magic Clip (אלחוטי)",
      titleAr: "Wahl Magic Clip (لاسلكي)",
      descriptionHe: "מכונת תספורת מקצועית, עוצמתית ונוחה לעבודה יומיומית בברברשופ.",
      descriptionAr: "ماكينة حلاقة احترافية قوية ومناسبة للعمل اليومي في صالون الحلاقة.",
      price: 599,
      stock: 24,
      categoryId: catByKey.get("CLIPPERS")._id,
      imageUrl: img.clipper,
      // ✅ was discountPercent only (old), now we derive salePrice automatically
      discountPercent: 10,
      saleStartAt: new Date(),
      saleEndAt: nowPlusDays(14),
      isFeatured: true,
      isBestSeller: true,
    },
    {
      titleHe: "BabylissPRO Skeleton Trimmer",
      titleAr: "BabylissPRO Skeleton Trimmer",
      descriptionHe: "טרימר דיוק לליינאפ חד וסימון זקן.",
      descriptionAr: "مشذب دقيق لخطوط حادة وتحديد اللحية.",
      price: 499,
      stock: 30,
      categoryId: catByKey.get("TRIMMERS")._id,
      imageUrl: img.trimmer,
      salePrice: 449, // ✅ explicit sale
      saleStartAt: new Date(),
      saleEndAt: nowPlusDays(10),
      isFeatured: true,
    },
    {
      titleHe: "Gillette Fusion סכין גילוח",
      titleAr: "Gillette Fusion شفرة حلاقة",
      descriptionHe: "סכין גילוח איכותית לגילוח חלק עם פחות גירוי.",
      descriptionAr: "شفرة حلاقة عالية الجودة لحلاقة ناعمة مع تهيج أقل.",
      price: 59,
      stock: 120,
      categoryId: catByKey.get("SHAVING")._id,
      imageUrl: img.razor,
      isBestSeller: true,
    },
    {
      titleHe: "ג'ל גילוח לעור רגיש",
      titleAr: "جل حلاقة للبشرة الحساسة",
      descriptionHe: "ג'ל מרגיע לעור רגיש, מפחית אדמומיות.",
      descriptionAr: "جل مهدئ للبشرة الحساسة ويقلل الاحمرار.",
      price: 45,
      stock: 140,
      categoryId: catByKey.get("SHAVING")._id,
      imageUrl: img.gel,
    },
    {
      titleHe: "ווקס לשיער – אחיזה חזקה",
      titleAr: "واكس شعر - تثبيت قوي",
      descriptionHe: "ווקס עם גימור מט ואחיזה חזקה לכל היום.",
      descriptionAr: "واكس بلمسة مطفية وتثبيت قوي طوال اليوم.",
      price: 39,
      stock: 200,
      categoryId: catByKey.get("HAIR_CARE")._id,
      imageUrl: img.wax,
      isFeatured: true,
    },
    {
      titleHe: "שמן זקן טבעי",
      titleAr: "زيت لحية طبيعي",
      descriptionHe: "מרכך את הזקן ומעניק ריח נקי ועדין.",
      descriptionAr: "ينعم اللحية ويمنح رائحة نظيفة ولطيفة.",
      price: 55,
      stock: 160,
      categoryId: catByKey.get("HAIR_CARE")._id,
      imageUrl: img.oil,
      discountPercent: 15, // ✅ will derive salePrice
      saleStartAt: new Date(),
      saleEndAt: nowPlusDays(7),
      isBestSeller: true,
    },
    {
      titleHe: "מברשת זקן איכותית",
      titleAr: "فرشاة لحية عالية الجودة",
      descriptionHe: "מברשת קומפקטית לסידור הזקן והפחתת פריז.",
      descriptionAr: "فرشاة مدمجة لترتيب اللحية وتقليل الهيشان.",
      price: 35,
      stock: 180,
      categoryId: catByKey.get("ACCESSORIES")._id,
      imageUrl: img.brush,
    },
    {
      titleHe: "מספריים מקצועיות",
      titleAr: "مقص احترافي",
      descriptionHe: "מספריים חדות ונוחות לעבודה מדויקת.",
      descriptionAr: "مقص حاد ومريح لعمل دقيق.",
      price: 89,
      stock: 60,
      categoryId: catByKey.get("ACCESSORIES")._id,
      imageUrl: img.scissors,
      isFeatured: true,
    },
    {
      titleHe: "מסרק פרימיום",
      titleAr: "مشط بريميوم",
      descriptionHe: "מסרק איכותי לסידור שיער וזקן.",
      descriptionAr: "مشط عالي الجودة لترتيب الشعر واللحية.",
      price: 19,
      stock: 400,
      categoryId: catByKey.get("ACCESSORIES")._id,
      imageUrl: img.comb,
    },
    {
      titleHe: "כיסוי ברבר (קייפ)",
      titleAr: "غطاء حلاقة (كاب)",
      descriptionHe: "קייפ ברבר קל ונוח – מתאים לכל לקוח.",
      descriptionAr: "غطاء حلاقة خفيف ومريح - مناسب للجميع.",
      price: 49,
      stock: 90,
      categoryId: catByKey.get("ACCESSORIES")._id,
      imageUrl: img.cape,
    },
    {
      titleHe: "שמפו לשיער – ניקוי עמוק",
      titleAr: "شامبو شعر - تنظيف عميق",
      descriptionHe: "שמפו לניקוי עמוק עם ריח רענן.",
      descriptionAr: "شامبو تنظيف عميق برائحة منعشة.",
      price: 42,
      stock: 130,
      categoryId: catByKey.get("HAIR_CARE")._id,
      imageUrl: img.shampoo,
    },
    {
      titleHe: "ספריי חיטוי לכלים",
      titleAr: "بخاخ تعقيم للأدوات",
      descriptionHe: "חיטוי מהיר ובטוח לכלי עבודה.",
      descriptionAr: "تعقيم سريع وآمن لأدوات العمل.",
      price: 29,
      stock: 180,
      categoryId: catByKey.get("ACCESSORIES")._id,
      imageUrl: img.disinfect,
    },
    {
      titleHe: "מכונת תספורת קווית",
      titleAr: "ماكينة حلاقة سلكية",
      descriptionHe: "מכונה קלאסית עם כוח יציב לשימוש אינטנסיבי.",
      descriptionAr: "ماكينة كلاسيكية بقوة ثابتة للاستخدام المكثف.",
      price: 299,
      stock: 40,
      categoryId: catByKey.get("CLIPPERS")._id,
      imageUrl: img.clipper,
    },
    {
      titleHe: "טרימר קומפקטי לניקוי קצוות",
      titleAr: "مشذب صغير لتنظيف الأطراف",
      descriptionHe: "טרימר קטן לניקוי קצוות ולדיוק גבוה.",
      descriptionAr: "مشذب صغير لتنظيف الأطراف بدقة عالية.",
      price: 159,
      stock: 70,
      categoryId: catByKey.get("TRIMMERS")._id,
      imageUrl: img.trimmer,
      isFeatured: true,
    },
    {
      titleHe: "מסרק זקן (מתנה)",
      titleAr: "مشط لحية (هدية)",
      descriptionHe: "מוצר מתנה – משמש לחוקי מתנות והטבות.",
      descriptionAr: "منتج هدية - يستخدم لقواعد الهدايا والعروض.",
      price: 0,
      stock: 999,
      categoryId: catByKey.get("ACCESSORIES")._id,
      imageUrl: img.comb,
      isActive: true,
    },
  ];

  const products = [];
  for (const p of productDocs) {
    const doc = normalizeProductDoc(p);

    // Upsert by stable unique key (titleHe)
    const saved = await upsertByFilter(Product, { titleHe: doc.titleHe }, doc);
    products.push(saved);
  }

  const productByTitleHe = new Map(products.map((p) => [p.titleHe, p]));

  /* -------------------------
     5) Shipping (Delivery + Pickup + Store pickup)
  ------------------------- */
  await Promise.all(
    [
      { nameHe: "מרכז (גוש דן)", nameAr: "الوسط (غوش دان)", fee: 25, isActive: true },
      { nameHe: "ירושלים והסביבה", nameAr: "القدس وضواحيها", fee: 30, isActive: true },
      { nameHe: "צפון (חיפה והקריות)", nameAr: "الشمال (حيفا)", fee: 35, isActive: true },
    ].map((a) => upsertByFilter(DeliveryArea, { nameHe: a.nameHe }, { ...a, name: a.nameHe })),
  );

  await Promise.all(
    [
      {
        nameHe: "נקודת איסוף – דיזנגוף סנטר",
        nameAr: "نقطة استلام - ديزينغوف سنتر",
        addressHe: "תל אביב-יפו, דיזנגוף סנטר, שער 3",
        addressAr: "تل أبيب-يافا، ديزينغوف سنتر، بوابة 3",
        fee: 10,
        isActive: true,
      },
      {
        nameHe: "נקודת איסוף – עזריאלי",
        nameAr: "نقطة استلام - عزرائيلي",
        addressHe: "תל אביב-יפו, מרכז עזריאלי, לוקר קומת כניסה",
        addressAr: "تل أبيب-يافا، مركز عزرائيلي، خزانة عند المدخل",
        fee: 12,
        isActive: true,
      },
    ].map((p) =>
      upsertByFilter(
        PickupPoint,
        { nameHe: p.nameHe },
        { ...p, name: p.nameHe, address: p.addressHe },
      ),
    ),
  );

  // Store pickup config singleton
  await StorePickupConfig.findOneAndUpdate(
    {},
    {
      $set: {
        isEnabled: true,
        fee: 0,
        addressHe: "תל אביב-יפו, אלנבי 99",
        addressAr: "تل أبيب-يافا، شارع ألنبي 99",
        notesHe: "שעות פתיחה: א׳–ה׳ 10:00–18:00",
        notesAr: "ساعات العمل: الأحد-الخميس 10:00-18:00",
        address: "תל אביב-יפו, אלנבי 99",
        notes: "שעות פתיחה: א׳–ה׳ 10:00–18:00",
      },
    },
    { upsert: true, new: true },
  );

  /* -------------------------
     6) Coupons (3)
     Coupon model: code,type,value,minOrderTotal,maxDiscount,usageLimit,usedCount,startAt,endAt,isActive
  ------------------------- */
  await upsertByFilter(Coupon, { code: "SAVE20" }, {
    code: "SAVE20",
    type: "percent",
    value: 20,
    minOrderTotal: 100,
    maxDiscount: 60,
    usageLimit: 500,
    usedCount: 0,
    startAt: new Date(),
    endAt: nowPlusDays(30),
    isActive: true,
  });

  await upsertByFilter(Coupon, { code: "WELCOME10" }, {
    code: "WELCOME10",
    type: "percent",
    value: 10,
    minOrderTotal: 50,
    maxDiscount: 30,
    usageLimit: 2000,
    usedCount: 0,
    startAt: new Date(),
    endAt: nowPlusDays(90),
    isActive: true,
  });

  await upsertByFilter(Coupon, { code: "FREESHIP" }, {
    code: "FREESHIP",
    type: "fixed",
    value: 25,
    minOrderTotal: 150,
    maxDiscount: 25,
    usageLimit: 1000,
    usedCount: 0,
    startAt: new Date(),
    endAt: nowPlusDays(45),
    isActive: true,
  });

  /* -------------------------
     7) Campaigns (2)
     Campaign model enum: type: ["percent","fixed"]
  ------------------------- */
  await upsertByFilter(Campaign, { nameHe: "מבצע סוף שבוע" }, {
    nameHe: "מבצע סוף שבוע",
    nameAr: "عرض نهاية الأسبوع",
    name: "מבצע סוף שבוע",
    type: "percent",
    value: 10,
    appliesTo: "categories",
    categoryIds: [catByKey.get("TRIMMERS")._id],
    productIds: [],
    startAt: new Date(),
    endAt: nowPlusDays(7),
    isActive: true,
  });

  await upsertByFilter(Campaign, { nameHe: "הנחת אקססוריז" }, {
    nameHe: "הנחת אקססוריז",
    nameAr: "خصم الإكسسوارات",
    name: "הנחת אקססוריז",
    type: "percent",
    value: 12,
    appliesTo: "categories",
    categoryIds: [catByKey.get("ACCESSORIES")._id],
    productIds: [],
    startAt: new Date(),
    endAt: nowPlusDays(14),
    isActive: true,
  });

  /* -------------------------
     8) Gifts (2)
     Gift: giftProductId + minOrderTotal + date window
  ------------------------- */
  const giftComb = productByTitleHe.get("מסרק זקן (מתנה)");
  if (!giftComb) throw new Error("Gift product not found: מסרק זקן (מתנה)");

  await upsertByFilter(Gift, { nameHe: "מתנה בקנייה מעל 200" }, {
    nameHe: "מתנה בקנייה מעל 200",
    nameAr: "هدية عند الشراء فوق 200",
    name: "מתנה בקנייה מעל 200",
    giftProductId: giftComb._id,
    minOrderTotal: 200,
    requiredProductId: null,
    requiredCategoryId: null,
    startAt: new Date(),
    endAt: nowPlusDays(60),
    isActive: true,
  });

  await upsertByFilter(Gift, { nameHe: "מתנה בקנייה מעל 350" }, {
    nameHe: "מתנה בקנייה מעל 350",
    nameAr: "هدية عند الشراء فوق 350",
    name: "מתנה בקנייה מעל 350",
    giftProductId: giftComb._id,
    minOrderTotal: 350,
    requiredProductId: null,
    requiredCategoryId: null,
    startAt: new Date(),
    endAt: nowPlusDays(90),
    isActive: true,
  });

  /* -------------------------
     9) Seasonal Offers (bilingual)
     Supported types: PERCENT_OFF, FIXED_OFF, FREE_SHIPPING, BUY_X_GET_Y
  ------------------------- */
  await upsertByFilter(Offer, { nameHe: "מבצע רמדאן" }, {
    nameHe: "מבצע רמדאן",
    nameAr: "عرض رمضان",
    name: "מבצע רמדאן",
    type: "PERCENT_OFF",
    value: 15,
    minTotal: 120,
    productIds: [],
    categoryIds: [catByKey.get("SHAVING")._id],
    stackable: true,
    priority: 10,
    startAt: new Date(),
    endAt: nowPlusDays(45),
    isActive: true,
  });

  await upsertByFilter(Offer, { nameHe: "מבצע עיד אל-אדחא" }, {
    nameHe: "מבצע עיד אל-אדחא",
    nameAr: "عرض عيد الأضحى",
    name: "מבצע עיד אל-אדחא",
    type: "FIXED_OFF",
    value: 25,
    minTotal: 250,
    productIds: [],
    categoryIds: [],
    stackable: true,
    priority: 20,
    startAt: new Date(),
    endAt: nowPlusDays(20),
    isActive: true,
  });

  await upsertByFilter(Offer, { nameHe: "משלוח חינם מעל 300" }, {
    nameHe: "משלוח חינם מעל 300",
    nameAr: "شحن مجاني فوق 300",
    name: "משלוח חינם מעל 300",
    type: "FREE_SHIPPING",
    value: 0,
    minTotal: 300,
    productIds: [],
    categoryIds: [],
    stackable: true,
    priority: 30,
    startAt: new Date(),
    endAt: nowPlusDays(60),
    isActive: true,
  });

  // BUY_X_GET_Y example
  const buyProduct = productByTitleHe.get("מסרק פרימיום");
  const getProduct = productByTitleHe.get("מסרק זקן (מתנה)");
  if (buyProduct && getProduct) {
    await upsertByFilter(Offer, { nameHe: "קנה 2 מסרקים וקבל מתנה" }, {
      nameHe: "קנה 2 מסרקים וקבל מתנה",
      nameAr: "اشترِ 2 أمشاط واحصل على هدية",
      name: "קנה 2 מסרקים וקבל מתנה",
      type: "BUY_X_GET_Y",
      value: 0,
      minTotal: 0,
      productIds: [],
      categoryIds: [],
      buyProductId: buyProduct._id,
      buyQty: 2,
      getProductId: getProduct._id,
      getQty: 1,
      maxDiscount: 0,
      stackable: false,
      priority: 40,
      startAt: new Date(),
      endAt: nowPlusDays(45),
      isActive: true,
    });
  }

  /* -------------------------
     10) Content Pages (required legal pages)
     Slugs: terms, privacy, shipping, returns, accessibility
  ------------------------- */
  const pages = [
    {
      slug: "terms",
      titleHe: "תקנון האתר",
      titleAr: "شروط الموقع",
      contentHe: "זהו טקסט דמה קצר לתקנון האתר. ניתן לערוך ולהחליף בטקסט משפטי מלא בהמשך.",
      contentAr: "هذا نص تجريبي قصير لشروط الموقع. يمكن تعديله واستبداله بنص قانوني كامل لاحقاً.",
      sortOrder: 10,
    },
    {
      slug: "privacy",
      titleHe: "מדיניות פרטיות",
      titleAr: "سياسة الخصوصية",
      contentHe: "זהו טקסט דמה למדיניות פרטיות. ניתן להוסיף פירוט על איסוף מידע, עוגיות ויצירת קשר.",
      contentAr: "هذا نص تجريبي لسياسة الخصوصية. يمكن إضافة تفاصيل حول جمع البيانات وملفات تعريف الارتباط وطرق التواصل.",
      sortOrder: 20,
    },
    {
      slug: "shipping",
      titleHe: "משלוחים ואיסוף",
      titleAr: "الشحن والاستلام",
      contentHe: "מידע בסיסי על משלוחים: זמני אספקה, אזורי חלוקה, נקודות איסוף ואיסוף עצמי מהחנות.",
      contentAr: "معلومات أساسية عن الشحن: مدة التوصيل، مناطق التغطية، نقاط الاستلام، والاستلام من المتجر.",
      sortOrder: 30,
    },
    {
      slug: "returns",
      titleHe: "החזרות והחלפות",
      titleAr: "الإرجاع والاستبدال",
      contentHe: "מדיניות בסיסית להחזרות והחלפות. ניתן להרחיב לפי חוק הגנת הצרכן ונהלי החנות.",
      contentAr: "سياسة أساسية للإرجاع والاستبدال. يمكن توسيعها حسب القوانين المحلية وسياسة المتجر.",
      sortOrder: 40,
    },
    {
      slug: "accessibility",
      titleHe: "הצהרת נגישות",
      titleAr: "تصريح إمكانية الوصول",
      contentHe: "אנו פועלים להנגשת האתר בהתאם לדרישות. ניתן לעדכן הצהרה מלאה כולל פרטי יצירת קשר.",
      contentAr: "نعمل على جعل الموقع متاحاً وفق المتطلبات. يمكن تحديث تصريح كامل مع معلومات الاتصال.",
      sortOrder: 50,
    },
  ];

  for (const p of pages) {
    await upsertByFilter(
      ContentPage,
      { slug: p.slug },
      {
        slug: p.slug,
        titleHe: p.titleHe,
        titleAr: p.titleAr,
        contentHe: p.contentHe,
        contentAr: p.contentAr,
        isActive: true,
        sortOrder: p.sortOrder,
      },
    );
  }

  /* -------------------------
     11) Wishlist items (test user)
  ------------------------- */
  const wishlistTitles = [
    "Wahl Magic Clip (אלחוטי)",
    "BabylissPRO Skeleton Trimmer",
    "שמן זקן טבעי",
  ];

  const wishlistProductIds = wishlistTitles
    .map((t) => productByTitleHe.get(t)?._id)
    .filter(Boolean);

  await User.updateOne({ _id: testUser._id }, { $set: { wishlist: wishlistProductIds } });

  /* -------------------------
     12) Sample Reviews (2-3)
     Review schema is single comment (not bilingual),
     so we seed a mixed comment (HE + AR)
  ------------------------- */
  const reviewTargets = [
    {
      productTitleHe: "Wahl Magic Clip (אלחוטי)",
      rating: 5,
      commentHe: "מכונה מצוינת! חיתוך חלק ועוצמה חזקה. ממליץ מאוד.",
      commentAr: "ماكينة ممتازة! قص ناعم وقوة عالية. أنصح بها جداً.",
    },
    {
      productTitleHe: "שמן זקן טבעי",
      rating: 4,
      commentHe: "ריח עדין ומרכך את הזקן. מחיר משתלם.",
      commentAr: "رائحة لطيفة وينعم اللحية. سعر مناسب.",
    },
    {
      productTitleHe: "מספריים מקצועיות",
      rating: 5,
      commentHe: "חדות מאוד ונוחות ביד. איכות גבוהה.",
      commentAr: "حادة جداً ومريحة باليد. جودة عالية.",
    },
  ];

  for (const r of reviewTargets) {
    const prod = productByTitleHe.get(r.productTitleHe);
    if (!prod) continue;

    const comment = `${r.commentHe}\n${r.commentAr}`;

    await Review.findOneAndUpdate(
      { productId: prod._id, userId: testUser._id },
      {
        $set: {
          productId: prod._id,
          userId: testUser._id,
          rating: Number(r.rating || 5),
          comment: String(comment || "").trim(),
        },
      },
      { upsert: true, new: true },
    );
  }

  /* -------------------------
     Summary
  ------------------------- */
  console.log("\n[seed] done ✅");
  console.log("Admin:");
  console.log(`  email: ${adminEmail}`);
  console.log(`  pass : ${adminPass}`);
  console.log("Test User:");
  console.log(`  email: ${testEmail}`);
  console.log(`  pass : ${testPass}`);
  console.log("Content Pages:");
  console.log("  terms, privacy, shipping, returns, accessibility");
  console.log("Sale rule compatibility:");
  console.log("  discountPercent -> derived salePrice (so onSale works)");
}

main()
  .catch((err) => {
    console.error("[seed] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      // ignore
    }
  });
