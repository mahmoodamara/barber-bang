// scripts/seed.js
// ✅ FULL Production-grade Seeder (Refactored + Unified + Idempotent-safe patterns)
// - Unified store identity across shipping/settings/content
// - Expanded product attributes
// - Refined categories + SEO
// - All listed products verified or spec-provided (KM-1735 confirmed by packaging)
// - Bilingual Hebrew/Arabic
// - Preserves your existing flows for promos/orders/ranking

import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

import { connectDB } from "../config/db.js";

import { User } from "../models/User.js";
import { Category } from "../models/Category.js";
import { Product } from "../models/Product.js";
import { ProductAttribute } from "../models/ProductAttribute.js";

import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { StorePickupConfig } from "../models/StorePickupConfig.js";

import { Coupon } from "../models/Coupon.js";
import { CouponReservation } from "../models/CouponReservation.js";
import { CouponRedemption } from "../models/CouponRedemption.js";
import { CouponUserUsage } from "../models/CouponUserUsage.js";
import { Campaign } from "../models/Campaign.js";
import { Offer } from "../models/Offer.js";
import { Gift } from "../models/Gift.js";

import { SiteSettings } from "../models/SiteSettings.js";
import { HomeLayout } from "../models/HomeLayout.js";
import { ContentPage } from "../models/ContentPage.js";

import { Review } from "../models/Review.js";
import { MediaAsset } from "../models/MediaAsset.js";
import { StockReservation } from "../models/StockReservation.js";
import { Order } from "../models/Order.js";
import { ReturnRequest } from "../models/ReturnRequest.js";
import { AuditLog } from "../models/AuditLog.js";
import { AdminApproval } from "../models/AdminApproval.js";
import { Payment } from "../models/Payment.js";
import { ProductEngagement } from "../models/ProductEngagement.js";
import { ProductSignalDaily } from "../models/ProductSignalDaily.js";
import { Counter } from "../models/Counter.js";

import {
  toMinorSafe,
  nowPlusDays,
  slugFromSku,
  validateSeedEnv,
  mustNotRunInProd,
  buildOrderPricing,
  buildOrderShipping,
  getNextOrderNumber,
} from "./seed.utils.js";

/* =========================================
   Unified Store Constants (Single Source of Truth)
========================================= */
const STORE = {
  nameHe: "Barber Bang",
  nameAr: "باربر بانغ",
  brandDisplayHe: "Pier Jouliet x Kemei",
  brandDisplayAr: "Pier Jouliet x Kemei",

  phone: "+972502934825",
  whatsapp: "+972502934825",
  email: "thebigbangcosmetics@gmail.com",
  legalNoticeEmail: "thebigbangcosmetics@gmail.com",

  addressHe: "מג'אר, ישראל",
  addressAr: "المغار، إسرائيل",
  addressEn: "Maghar, Israel",

  businessHoursHe: "א׳, ג׳-ש׳ 10:00-20:00 (סגור ביום ב׳)",
  businessHoursAr: "الأحد والثلاثاء-السبت 10:00 - 20:00 (مغلق يوم الإثنين)",

  shippingNoteHe:
    "עלות ותנאי משלוח מוצגים בעמוד התשלום (Checkout) בהתאם לכתובת, לאזור החלוקה ולשיטת המסירה שנבחרה.",
  shippingNoteAr:
    "تكلفة وشروط الشحن تظهر في صفحة الدفع (Checkout) بحسب العنوان، منطقة التوصيل، وطريقة التسليم المختارة.",

  hygieneNoteHe:
    "מוצרים היגייניים/קוסמטיים העלולים להיפגע בפתיחה או בשימוש עשויים שלא להיות ניתנים להחזרה לאחר פתיחה/שימוש, בכפוף לדין.",
  hygieneNoteAr:
    "المنتجات الصحية/التجميلية التي تتأثر بالفتح أو الاستخدام قد لا تكون قابلة للإرجاع بعد الفتح/الاستخدام، وذلك وفقًا للقانون.",

  legalDisclaimerHe:
    "המידע באתר הוא מידע כללי לצרכן ואינו מהווה ייעוץ משפטי. במקרה של סתירה – הוראות הדין החל בישראל גוברות.",
  legalDisclaimerAr:
    "المعلومات المنشورة في الموقع هي معلومات عامة للمستهلك ولا تُعد استشارة قانونية. عند أي تعارض، تكون الأولوية لأحكام القانون الساري في إسرائيل.",
};

/* =========================================
   Generic Helpers
========================================= */
function ensureUniqueByKey(arr, key = "key") {
  const seen = new Set();
  const out = [];
  for (const item of arr || []) {
    const v = String(item?.[key] || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(item);
  }
  return out;
}

function sortByOrder(arr, orderKey = "sortOrder") {
  return [...(arr || [])].sort((a, b) => Number(a?.[orderKey] || 0) - Number(b?.[orderKey] || 0));
}

const CATEGORY_KEY = Object.freeze({
  HAIR_CLIPPERS: "hair_clippers",
  FOIL_SHAVERS: "foil_shavers",
  TRIMMERS: "trimmers",
  HAIR_DRYERS_BLOWERS: "hair_dryers_blowers",
  ELECTRIC_HAIR_STYLERS: "electric_hair_stylers",
  FACIAL_CARE: "facial_care",
  WAX_HAIR_REMOVAL: "wax_hair_removal",
  HAIR_CARE: "hair_care",
  STYLING_PRODUCTS: "styling_products",
  BEARD_AFTER_SHAVE: "beard_after_shave",
  BUNDLES: "bundles",
  MACHINE_MAINTENANCE: "machine_maintenance",
});

const CATEGORY_AR_BY_KEY = Object.freeze({
  [CATEGORY_KEY.HAIR_CLIPPERS]: "ماكينات قص الشعر",
  [CATEGORY_KEY.FOIL_SHAVERS]: "ماكينات حلاقة الوجه / الشيفرات",
  [CATEGORY_KEY.TRIMMERS]: "تريمرات وتشذيب دقيق",
  [CATEGORY_KEY.HAIR_DRYERS_BLOWERS]: "مجففات الشعر والمنافخ",
  [CATEGORY_KEY.ELECTRIC_HAIR_STYLERS]: "مصففات الشعر الكهربائية",
  [CATEGORY_KEY.FACIAL_CARE]: "العناية بالوجه",
  [CATEGORY_KEY.WAX_HAIR_REMOVAL]: "إزالة الشعر والشمع",
  [CATEGORY_KEY.HAIR_CARE]: "شامبو وعناية الشعر",
  [CATEGORY_KEY.STYLING_PRODUCTS]: "تصفيف الشعر",
  [CATEGORY_KEY.BEARD_AFTER_SHAVE]: "العناية باللحية وما بعد الحلاقة",
  [CATEGORY_KEY.BUNDLES]: "أطقم وباقات",
  [CATEGORY_KEY.MACHINE_MAINTENANCE]: "صيانة وتعقيم الماكينات",
});

const CATEGORY_PRIMARY_BY_KEY = Object.freeze({
  [CATEGORY_KEY.HAIR_CLIPPERS]: "Hair Clipper",
  [CATEGORY_KEY.FOIL_SHAVERS]: "Foil Shaver",
  [CATEGORY_KEY.TRIMMERS]: "Trimmer / Precision Grooming",
  [CATEGORY_KEY.HAIR_DRYERS_BLOWERS]: "Hair Dryer / Blower",
  [CATEGORY_KEY.ELECTRIC_HAIR_STYLERS]: "Electric Hair Styler",
  [CATEGORY_KEY.FACIAL_CARE]: "Facial Care Device",
  [CATEGORY_KEY.WAX_HAIR_REMOVAL]: "Hair Removal / Wax",
  [CATEGORY_KEY.HAIR_CARE]: "Hair Care",
  [CATEGORY_KEY.STYLING_PRODUCTS]: "Hair Styling Product",
  [CATEGORY_KEY.BEARD_AFTER_SHAVE]: "Beard Care / After Shave",
  [CATEGORY_KEY.BUNDLES]: "Bundle / Kit",
  [CATEGORY_KEY.MACHINE_MAINTENANCE]: "Machine Maintenance / Disinfection",
});

const CATEGORY_SECONDARY_BY_KEY = Object.freeze({
  [CATEGORY_KEY.HAIR_CLIPPERS]: "Clipper / Barber / Fade",
  [CATEGORY_KEY.FOIL_SHAVERS]: "Foil / Face Shaver",
  [CATEGORY_KEY.TRIMMERS]: "T-Blade / Detail / Body / Nose & Ear",
  [CATEGORY_KEY.HAIR_DRYERS_BLOWERS]: "Hair Dryer / Blower / Compressor",
  [CATEGORY_KEY.ELECTRIC_HAIR_STYLERS]: "Hot Brush / Straightener / Curler",
  [CATEGORY_KEY.FACIAL_CARE]: "Facial Cleansing Device",
  [CATEGORY_KEY.WAX_HAIR_REMOVAL]: "Wax / Hair Removal",
  [CATEGORY_KEY.HAIR_CARE]: "Shampoo / Mask / Treatment",
  [CATEGORY_KEY.STYLING_PRODUCTS]: "Wax / Clay / Styling Hold",
  [CATEGORY_KEY.BEARD_AFTER_SHAVE]: "Beard Care / After Shave",
  [CATEGORY_KEY.BUNDLES]: "Bundle / Multi-Item Kit",
  [CATEGORY_KEY.MACHINE_MAINTENANCE]: "Maintenance / Disinfection",
});

const NON_DEVICE_CATEGORY_PRIORITY = [
  CATEGORY_KEY.BUNDLES,
  CATEGORY_KEY.MACHINE_MAINTENANCE,
  CATEGORY_KEY.WAX_HAIR_REMOVAL,
  CATEGORY_KEY.HAIR_CARE,
  CATEGORY_KEY.STYLING_PRODUCTS,
  CATEGORY_KEY.BEARD_AFTER_SHAVE,
  CATEGORY_KEY.FACIAL_CARE,
];

// Required device keyword priority:
// Foil/Shaver > Trimmer > Hair Styler > Hair Dryer/Blower > Clipper
const DEVICE_CATEGORY_PRIORITY = [
  CATEGORY_KEY.FOIL_SHAVERS,
  CATEGORY_KEY.TRIMMERS,
  CATEGORY_KEY.ELECTRIC_HAIR_STYLERS,
  CATEGORY_KEY.HAIR_DRYERS_BLOWERS,
  CATEGORY_KEY.HAIR_CLIPPERS,
];

const CATEGORY_KEYWORDS = Object.freeze({
  [CATEGORY_KEY.BUNDLES]: [
    "bundle",
    "kit",
    "set",
    "bundle kit",
    "mystery box",
    "مجموعة",
    "طقم",
    "أطقم",
    "باقة",
    "מארז",
    "באנדל",
    "ערכה",
    "סט",
  ],
  [CATEGORY_KEY.MACHINE_MAINTENANCE]: [
    "maintenance",
    "disinfect",
    "disinfection",
    "sanitize",
    "sanitizing",
    "steril",
    "blade spray",
    "clipper spray",
    "4-in-1 spray",
    "spray 4-in-1",
    "صيانة",
    "تعقيم",
    "تطهير",
    "حماية الشفرات",
    "תחזוקה",
    "חיטוי",
    "ספריי חיטוי",
  ],
  [CATEGORY_KEY.WAX_HAIR_REMOVAL]: [
    "hair removal",
    "depil",
    "wax heater",
    "wax warming",
    "body wax",
    "hot wax",
    "إزالة الشعر",
    "الشمع",
    "شمع",
    "سخان شمع",
    "תסיר שיער",
    "הסרת שיער",
    "שעווה",
    "מחמם שעווה",
  ],
  [CATEGORY_KEY.HAIR_CARE]: [
    "shampoo",
    "mask",
    "leave-in",
    "treatment",
    "keratin",
    "hair cream",
    "therapycare",
    "شامبو",
    "ماسك",
    "عناية الشعر",
    "كيراتين",
    "שמפו",
    "מסכה",
    "קרטין",
    "טיפוח שיער",
  ],
  [CATEGORY_KEY.STYLING_PRODUCTS]: [
    "clay wax",
    "aqua wax",
    "booster wax",
    "matte wax",
    "wax",
    "clay",
    "pomade",
    "hair styling",
    "hold",
    "تصفيف",
    "واكس",
    "كلاي",
    "ווקס",
    "עיצוב שיער",
    "חימר לשיער",
  ],
  [CATEGORY_KEY.BEARD_AFTER_SHAVE]: [
    "beard",
    "mustache",
    "after shave",
    "aftershave",
    "cologne",
    "post-shave",
    "لحية",
    "شارب",
    "ما بعد الحلاقة",
    "افتر شيف",
    "كولونيا",
    "זקן",
    "אחרי גילוח",
    "אפטר שייב",
  ],
  [CATEGORY_KEY.FACIAL_CARE]: [
    "facial care",
    "facial cleanser",
    "face cleaner",
    "العناية بالوجه",
    "تنظيف الوجه",
    "טיפוח פנים",
    "ניקוי פנים",
  ],
  [CATEGORY_KEY.FOIL_SHAVERS]: ["foil", "foil shaver", "shaver", "face shaver", "wet & dry shaver", "شيفر", "فويل", "ماكينة فويل", "ماشينة فويل", "שייבר", "מכונת גילוח"],
  [CATEGORY_KEY.TRIMMERS]: [
    "trimmer",
    "t-blade",
    "outline",
    "detailing",
    "nose",
    "ear",
    "body trimmer",
    "تشذيب",
    "تحديد",
    "تريمر",
    "تشذيب دقيق",
    "أنف",
    "أذن",
    "טרימר",
    "קוצץ",
    "tblade",
  ],
  [CATEGORY_KEY.ELECTRIC_HAIR_STYLERS]: [
    "electric hair brush",
    "hair styler",
    "styling brush",
    "hot brush",
    "straightener",
    "flat iron",
    "curler",
    "curling",
    "فرشاة شعر كهربائية",
    "مصفف شعر",
    "مصففات شعر",
    "מברשת שיער חשמלית",
    "מחליק",
    "מסלסל",
  ],
  [CATEGORY_KEY.HAIR_DRYERS_BLOWERS]: [
    "مجفف",
    "سشوار",
    "dryer",
    "blow dryer",
    "מפוח",
    "blower",
    "compressor",
    "cyclone",
    "tornado",
    "tifone",
    "פן",
    "מייבש שיער",
  ],
  [CATEGORY_KEY.HAIR_CLIPPERS]: [
    "clipper",
    "barber clipper",
    "fade clipper",
    "grading clipper",
    "ماكينة قص",
    "ماكينة تدريج",
    "قص الشعر",
    "מכונת תספורת",
    "מכונת דירוג",
  ],
});

function normalizeCategoryText(input) {
  return String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function includesAnyKeyword(text, keywords = []) {
  if (!text) return false;
  return keywords.some((keyword) => {
    const normalizedKeyword = normalizeCategoryText(keyword);
    return normalizedKeyword ? text.includes(normalizedKeyword) : false;
  });
}

function detectCategoryKey(text, orderedKeys) {
  const normalizedText = normalizeCategoryText(text);
  if (!normalizedText) return null;

  for (const key of orderedKeys) {
    const keywords = CATEGORY_KEYWORDS[key] || [];
    if (includesAnyKeyword(normalizedText, keywords)) return key;
  }
  return null;
}

function resolveProductCategoryKey(product) {
  const categoryPrimaryText = String(product?.classification?.categoryPrimary || "");
  const categorySecondaryText = String(product?.classification?.categorySecondary || "");
  const classificationText = [
    categoryPrimaryText,
    categorySecondaryText,
  ]
    .filter(Boolean)
    .join(" ");

  const searchableText = [
    product?.titleHe,
    product?.titleAr,
    product?.descriptionHe,
    product?.descriptionAr,
    classificationText,
    product?.brand,
    product?.sku,
    ...(product?.tags || []),
  ]
    .filter(Boolean)
    .join(" ");

  const primaryOrderedKeys = [...NON_DEVICE_CATEGORY_PRIORITY, ...DEVICE_CATEGORY_PRIORITY];
  const explicitPrimaryKey = detectCategoryKey(categoryPrimaryText, primaryOrderedKeys);
  if (explicitPrimaryKey) return explicitPrimaryKey;

  const classificationDeviceKey = detectCategoryKey(classificationText, DEVICE_CATEGORY_PRIORITY);
  if (classificationDeviceKey) return classificationDeviceKey;

  const classificationNonDeviceKey = detectCategoryKey(classificationText, NON_DEVICE_CATEGORY_PRIORITY);
  if (classificationNonDeviceKey) return classificationNonDeviceKey;

  const inferredDeviceKey = detectCategoryKey(searchableText, DEVICE_CATEGORY_PRIORITY);
  const inferredNonDeviceKey = detectCategoryKey(searchableText, NON_DEVICE_CATEGORY_PRIORITY);

  if (
    inferredDeviceKey &&
    inferredNonDeviceKey &&
    inferredNonDeviceKey !== CATEGORY_KEY.BUNDLES &&
    inferredNonDeviceKey !== CATEGORY_KEY.MACHINE_MAINTENANCE
  ) {
    console.warn(
      `⚠️ Category keyword overlap for ${product?.sku || "UNKNOWN-SKU"}: device=${inferredDeviceKey}, nonDevice=${inferredNonDeviceKey}. Using device priority.`
    );
  }

  if (inferredNonDeviceKey === CATEGORY_KEY.BUNDLES || inferredNonDeviceKey === CATEGORY_KEY.MACHINE_MAINTENANCE) {
    return inferredNonDeviceKey;
  }

  return inferredDeviceKey || inferredNonDeviceKey || null;
}

function buildCategoryMapByKey(categories) {
  const byNameAr = new Map(categories.map((c) => [c.nameAr, c]));
  const byKey = new Map();

  for (const [key, nameAr] of Object.entries(CATEGORY_AR_BY_KEY)) {
    byKey.set(key, byNameAr.get(nameAr));
  }

  return byKey;
}

async function wipeDatabase() {
  console.log("🧹 WIPING DATABASE...");

  const deletionOrder = [
    { model: AuditLog, name: "Audit Logs" },
    { model: AdminApproval, name: "Admin Approvals" },
    { model: Payment, name: "Payments" },
    { model: ProductEngagement, name: "Product Engagement" },
    { model: ProductSignalDaily, name: "Product Signals Daily" },
    { model: StockReservation, name: "Stock Reservations" },
    { model: ReturnRequest, name: "Return Requests" },
    { model: Order, name: "Orders" },
    { model: CouponRedemption, name: "Coupon Redemptions" },
    { model: CouponReservation, name: "Coupon Reservations" },
    { model: CouponUserUsage, name: "Coupon User Usage" },
    { model: Review, name: "Reviews" },
    { model: Gift, name: "Gifts" },
    { model: Offer, name: "Offers" },
    { model: Campaign, name: "Campaigns" },
    { model: Coupon, name: "Coupons" },
    { model: HomeLayout, name: "Home Layouts" },
    { model: SiteSettings, name: "Site Settings" },
    { model: ContentPage, name: "Content Pages" },
    { model: StorePickupConfig, name: "Store Pickup Config" },
    { model: PickupPoint, name: "Pickup Points" },
    { model: DeliveryArea, name: "Delivery Areas" },
    { model: MediaAsset, name: "Media Assets" },
    { model: Product, name: "Products" },
    { model: Category, name: "Categories" },
    { model: ProductAttribute, name: "Product Attributes" },
    { model: Counter, name: "Counters" },
    { model: User, name: "Users" },
  ];

  let totalDeleted = 0;

  for (const { model, name } of deletionOrder) {
    try {
      const res = await model.deleteMany({});
      const n = Number(res.deletedCount || 0);
      totalDeleted += n;
      console.log(`✅ Deleted ${n} from ${name}`);
    } catch (e) {
      console.warn(`⚠️ Could not delete ${name}: ${e?.message || e}`);
    }
  }

  console.log(`📊 TOTAL deleted docs: ${totalDeleted}`);
  console.log("✅ DATABASE wiped successfully");
}

async function createUsers() {
  console.log("👤 Creating users...");

  const adminEmail = String(process.env.SEED_ADMIN_EMAIL || "").trim().toLowerCase();
  const staffEmail = String(process.env.SEED_STAFF_EMAIL || "").trim().toLowerCase();
  const testEmail = String(process.env.SEED_TEST_EMAIL || "").trim().toLowerCase();

  const adminPassword = String(process.env.SEED_ADMIN_PASSWORD || "");
  const staffPassword = String(process.env.SEED_STAFF_PASSWORD || "");
  const testPassword = String(process.env.SEED_TEST_PASSWORD || "");

  const saltRounds = Number(process.env.BCRYPT_ROUNDS || 10);

  const [adminHash, staffHash, testHash] = await Promise.all([
    bcrypt.hash(adminPassword, saltRounds),
    bcrypt.hash(staffPassword, saltRounds),
    bcrypt.hash(testPassword, saltRounds),
  ]);

  const [admin, staff, user] = await User.create([
    {
      name: "Admin",
      email: adminEmail,
      passwordHash: adminHash,
      role: "admin",
      permissions: [],
      tokenVersion: 0,
      isBlocked: false,
    },
    {
      name: "Staff",
      email: staffEmail,
      passwordHash: staffHash,
      role: "staff",
      permissions: ["ORDERS_WRITE", "PRODUCTS_WRITE", "PROMOS_WRITE", "SETTINGS_WRITE"],
      tokenVersion: 0,
      isBlocked: false,
    },
    {
      name: "Test User",
      email: testEmail,
      passwordHash: testHash,
      role: "user",
      permissions: [],
      tokenVersion: 0,
      isBlocked: false,
    },
  ]);

  console.log("✅ Users created");
  return { admin, staff, user };
}

/* =========================================
   Product Attributes (Expanded)
========================================= */
async function createProductAttributes() {
  console.log("🏷️ Creating product attributes (expanded)...");

  const input = [
    // Common
    { key: "brand_series", nameHe: "סדרת מותג", nameAr: "سلسلة العلامة", type: "text", unit: "", options: [], isActive: true },
    { key: "origin_country", nameHe: "ארץ ייצור", nameAr: "بلد الصنع", type: "text", unit: "", options: [], isActive: true },
    { key: "warranty_months", nameHe: "אחריות (חודשים)", nameAr: "الضمان (شهور)", type: "number", unit: "months", options: [], isActive: true },

    // Styling / Hair Care
    {
      key: "hold_level",
      nameHe: "רמת אחיזה",
      nameAr: "مستوى التثبيت",
      type: "enum",
      unit: "",
      options: [
        { valueKey: "light", labelHe: "קל", labelAr: "خفيف", isActive: true },
        { valueKey: "medium", labelHe: "בינוני", labelAr: "متوسط", isActive: true },
        { valueKey: "strong", labelHe: "חזק", labelAr: "قوي", isActive: true },
      ],
      isActive: true,
    },
    {
      key: "finish_type",
      nameHe: "סוג גימור",
      nameAr: "نوع اللمعة",
      type: "enum",
      unit: "",
      options: [
        { valueKey: "matte", labelHe: "מט", labelAr: "مطفي", isActive: true },
        { valueKey: "natural", labelHe: "טבעי", labelAr: "طبيعي", isActive: true },
        { valueKey: "shine", labelHe: "מבריק", labelAr: "لامع", isActive: true },
        { valueKey: "high_shine", labelHe: "מבריק מאוד", labelAr: "لامع جدًا", isActive: true },
      ],
      isActive: true,
    },
    {
      key: "scent",
      nameHe: "ריח",
      nameAr: "الرائحة",
      type: "enum",
      unit: "",
      options: [
        { valueKey: "fresh", labelHe: "רענן", labelAr: "منعش", isActive: true },
        { valueKey: "unscented", labelHe: "ללא ריח", labelAr: "بدون رائحة", isActive: true },
      ],
      isActive: true,
    },
    {
      key: "hair_type",
      nameHe: "סוג שיער",
      nameAr: "نوع الشعر",
      type: "enum",
      unit: "",
      options: [
        { valueKey: "all", labelHe: "לכל הסוגים", labelAr: "كل الأنواع", isActive: true },
        { valueKey: "normal", labelHe: "רגיל", labelAr: "عادي", isActive: true },
        { valueKey: "oily", labelHe: "שומני", labelAr: "دهني", isActive: true },
        { valueKey: "dry", labelHe: "יבש", labelAr: "جاف", isActive: true },
      ],
      isActive: true,
    },
    { key: "volume_ml", nameHe: "נפח (מ״ל)", nameAr: "الحجم (مل)", type: "number", unit: "ml", options: [], isActive: true },
    { key: "weight_g", nameHe: "משקל (גרם)", nameAr: "الوزن (غرام)", type: "number", unit: "g", options: [], isActive: true },

    // Devices
    {
      key: "device_type",
      nameHe: "סוג מכשיר",
      nameAr: "نوع الجهاز",
      type: "enum",
      unit: "",
      options: [
        { valueKey: "hair_clipper", labelHe: "מכונת תספורת", labelAr: "ماكينة قص شعر", isActive: true },
        { valueKey: "body_trimmer", labelHe: "טרימר גוף", labelAr: "تريمر الجسم", isActive: true },
        { valueKey: "t_blade_trimmer", labelHe: "טרימר T-Blade", labelAr: "تريمر T-Blade", isActive: true },
        { valueKey: "foil_shaver", labelHe: "מכונת גילוח פויל", labelAr: "ماكينة فويل", isActive: true },
        { valueKey: "facial_cleaner", labelHe: "מכשיר ניקוי פנים", labelAr: "جهاز تنظيف الوجه", isActive: true },
      ],
      isActive: true,
    },
    { key: "motor_speed_rpm", nameHe: "מהירות מנוע (RPM)", nameAr: "سرعة المحرك (RPM)", type: "number", unit: "RPM", options: [], isActive: true },
    { key: "battery_capacity_mah", nameHe: "קיבולת סוללה (mAh)", nameAr: "سعة البطارية (mAh)", type: "number", unit: "mAh", options: [], isActive: true },
    { key: "charging_time_hours", nameHe: "זמן טעינה (שעות)", nameAr: "وقت الشحن (ساعات)", type: "number", unit: "hours", options: [], isActive: true },
    { key: "runtime_minutes", nameHe: "זמן פעולה (דקות)", nameAr: "وقت التشغيل (دقائق)", type: "number", unit: "minutes", options: [], isActive: true },
    {
      key: "waterproof_rating",
      nameHe: "דירוג עמידות למים",
      nameAr: "تصنيف مقاومة الماء",
      type: "enum",
      unit: "",
      options: [
        { valueKey: "no", labelHe: "לא", labelAr: "لا", isActive: true },
        { valueKey: "yes", labelHe: "כן", labelAr: "نعم", isActive: true },
        { valueKey: "ipx6", labelHe: "IPX6", labelAr: "IPX6", isActive: true },
        { valueKey: "ipx7", labelHe: "IPX7", labelAr: "IPX7", isActive: true },
      ],
      isActive: true,
    },
    {
      key: "wet_dry_use",
      nameHe: "שימוש יבש/רטוב",
      nameAr: "استخدام جاف/رطب",
      type: "enum",
      unit: "",
      options: [
        { valueKey: "dry_only", labelHe: "יבש בלבד", labelAr: "جاف فقط", isActive: true },
        { valueKey: "wet_dry", labelHe: "רטוב/יבש", labelAr: "جاف/رطب", isActive: true },
      ],
      isActive: true,
    },
    {
      key: "blade_type",
      nameHe: "סוג להב",
      nameAr: "نوع الشفرة",
      type: "enum",
      unit: "",
      options: [
        { valueKey: "stainless_steel", labelHe: "נירוסטה", labelAr: "ستانلس ستيل", isActive: true },
        { valueKey: "ceramic", labelHe: "קרמי", labelAr: "سيراميك", isActive: true },
        { valueKey: "titanium", labelHe: "טיטניום", labelAr: "تيتانيوم", isActive: true },
        { valueKey: "dlc", labelHe: "DLC", labelAr: "DLC", isActive: true },
      ],
      isActive: true,
    },
    { key: "speed_levels", nameHe: "מספר מהירויות", nameAr: "عدد السرعات", type: "number", unit: "", options: [], isActive: true },
    {
      key: "display_type",
      nameHe: "סוג תצוגה",
      nameAr: "نوع الشاشة",
      type: "enum",
      unit: "",
      options: [
        { valueKey: "led", labelHe: "LED", labelAr: "LED", isActive: true },
        { valueKey: "lcd", labelHe: "LCD", labelAr: "LCD", isActive: true },
        { valueKey: "none", labelHe: "ללא", labelAr: "بدون", isActive: true },
      ],
      isActive: true,
    },
    {
      key: "charging_type",
      nameHe: "סוג טעינה",
      nameAr: "نوع الشحن",
      type: "enum",
      unit: "",
      options: [
        { valueKey: "usb", labelHe: "USB", labelAr: "USB", isActive: true },
        { valueKey: "usb_c", labelHe: "USB Type-C", labelAr: "USB Type-C", isActive: true },
        { valueKey: "wireless", labelHe: "אלחוטי", labelAr: "لاسلكي", isActive: true },
      ],
      isActive: true,
    },
    { key: "voltage_compatibility", nameHe: "תאימות מתח", nameAr: "توافق الجهد", type: "text", unit: "", options: [], isActive: true },
  ];

  const unique = ensureUniqueByKey(input, "key");
  const attrs = await ProductAttribute.create(unique);

  console.log(`✅ Product attributes created: ${attrs.length}`);
  return attrs;
}

/* =========================================
   Categories (Refined)
========================================= */
async function createCategories() {
  console.log("📚 Creating categories (refined)...");

  const categoriesInput = [
    {
      nameHe: "מכונות תספורת",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.HAIR_CLIPPERS],
      imageUrl: "/uploads/seed/categories/hair-clippers.jpg",
      descriptionHe: "מכונות תספורת מקצועיות לשימוש ביתי ומקצועי.",
      descriptionAr: "ماكينات قص احترافية للاستخدام المنزلي والمهني.",
      isActive: true,
      sortOrder: 10,
      metaTitleHe: "מכונות תספורת מקצועיות | Kemei",
      metaTitleAr: "ماكينات قص احترافية | Kemei",
      metaDescriptionHe: "מבחר מכונות תספורת איכותיות לגברים.",
      metaDescriptionAr: "تشكيلة ماكينات قص عالية الجودة للرجال.",
    },
    {
      nameHe: "מכונות גילוח פויל",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.FOIL_SHAVERS],
      imageUrl: "/uploads/seed/categories/foil-shavers.jpg",
      descriptionHe: "מכונות פויל לגילוח חלק, מהיר ונקי.",
      descriptionAr: "ماكينات فويل لحلاقة ناعمة وسريعة ونظيفة.",
      isActive: true,
      sortOrder: 20,
      metaTitleHe: "מכונות גילוח פויל | Kemei",
      metaTitleAr: "ماكينات فويل | Kemei",
      metaDescriptionHe: "מכונות פויל איכותיות לביצוע מקצועי.",
      metaDescriptionAr: "ماكينات فويل عالية الجودة لأداء احترافي.",
    },
    {
      nameHe: "טרימרים מקצועיים",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.TRIMMERS],
      imageUrl: "/uploads/seed/categories/trimmers.jpg",
      descriptionHe: "טרימרים לדיוק קווים, T-Blade וטרימרי גוף.",
      descriptionAr: "تريمرات للتحديد الدقيق، T-Blade وتريمر الجسم.",
      isActive: true,
      sortOrder: 30,
      metaTitleHe: "טרימרים מקצועיים | T-Blade & Body Trimmers",
      metaTitleAr: "تريمرات احترافية | T-Blade وتريمر الجسم",
      metaDescriptionHe: "טרימרים מקצועיים לכל צורך.",
      metaDescriptionAr: "تريمرات احترافية لكل احتياج.",
    },
    {
      nameHe: "מייבשי שיער ומפוחים",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.HAIR_DRYERS_BLOWERS],
      imageUrl: "/uploads/seed/categories/hair-dryers.jpg",
      descriptionHe: "מייבשי שיער מקצועיים, מפוחים וקומפרסורים לעמדת העבודה.",
      descriptionAr: "مجففات شعر احترافية ومنافخ/كمبروسرات لمحطة العمل.",
      isActive: true,
      sortOrder: 35,
      metaTitleHe: "מייבשי שיער ומפוחים מקצועיים",
      metaTitleAr: "مجففات الشعر والمنافخ الاحترافية",
      metaDescriptionHe: "מייבשים ומפוחים חזקים לייבוש וניקוי מקצועי.",
      metaDescriptionAr: "مجففات ومنافخ قوية للتجفيف والتنظيف الاحترافي.",
    },
    {
      nameHe: "מכשירי עיצוב שיער חשמליים",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.ELECTRIC_HAIR_STYLERS],
      imageUrl: "/uploads/seed/categories/electric-stylers.jpg",
      descriptionHe: "מברשות ומכשירי עיצוב שיער חשמליים לעיצוב מהיר ומדויק.",
      descriptionAr: "مصففات وفرش شعر كهربائية لتصفيف سريع ودقيق.",
      isActive: true,
      sortOrder: 38,
      metaTitleHe: "מכשירי עיצוב שיער חשמליים",
      metaTitleAr: "مصففات الشعر الكهربائية",
      metaDescriptionHe: "כלי עיצוב חשמליים: מברשות חמות, מחליקים ומסלסלים.",
      metaDescriptionAr: "أجهزة تصفيف كهربائية: فرش حرارية ومكواة وفير.",
    },
    {
      nameHe: "טיפוח פנים",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.FACIAL_CARE],
      imageUrl: "/uploads/seed/categories/facial-care.jpg",
      descriptionHe: "מכשירי ניקוי וטיפוח פנים מתקדמים.",
      descriptionAr: "أجهزة تنظيف وعناية متقدمة للوجه.",
      isActive: true,
      sortOrder: 40,
      metaTitleHe: "מכשירי טיפוח פנים",
      metaTitleAr: "أجهزة العناية بالوجه",
      metaDescriptionHe: "מכשירים לטיפוח וניקוי פנים.",
      metaDescriptionAr: "أجهزة لإزالة الشوائب والعناية بالوجه.",
    },
    {
      nameHe: "הסרת שיער ושעווה",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.WAX_HAIR_REMOVAL],
      imageUrl: "/uploads/seed/categories/facial-care.jpg",
      descriptionHe: "מכשירים ומוצרים לחימום שעווה והסרת שיער בבית או בקליניקה.",
      descriptionAr: "أجهزة ومنتجات لتسخين الشمع وإزالة الشعر للاستخدام المنزلي أو المهني.",
      isActive: true,
      sortOrder: 45,
      metaTitleHe: "מכשירי שעווה והסרת שיער",
      metaTitleAr: "أجهزة الشمع وإزالة الشعر",
      metaDescriptionHe: "פתרונות חכמים להסרת שיער עם חימום שעווה מבוקר ומדויק.",
      metaDescriptionAr: "حلول ذكية لإزالة الشعر مع تسخين شمع مضبوط ودقيق.",
    },
    {
      nameHe: "שמפו וטיפוח שיער",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.HAIR_CARE],
      imageUrl: "/uploads/seed/categories/hair-care.jpg",
      descriptionHe: "שמפו טיפולי, מסכות ומוצרי טיפול ללא שטיפה.",
      descriptionAr: "شامبو علاجي، ماسكات ومنتجات عناية بدون شطف.",
      isActive: true,
      sortOrder: 50,
      metaTitleHe: "שמפו וטיפוח שיער | Pier Jouliet",
      metaTitleAr: "شامبو وعناية الشعر | Pier Jouliet",
      metaDescriptionHe: "מוצרי טיפוח שיער איכותיים לשגרה יומיומית.",
      metaDescriptionAr: "منتجات عناية بالشعر عالية الجودة للاستخدام اليومي.",
    },
    {
      nameHe: "עיצוב שיער",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.STYLING_PRODUCTS],
      imageUrl: "/uploads/seed/categories/styling.jpg",
      descriptionHe: "ווקסים ומוצרי סטיילינג - מט, טבעי ומבריק.",
      descriptionAr: "واكسات ومنتجات تصفيف - مطفي، طبيعي ولامع.",
      isActive: true,
      sortOrder: 60,
      metaTitleHe: "מוצרי עיצוב שיער | Wax & Styling",
      metaTitleAr: "منتجات تصفيف الشعر | Wax & Styling",
      metaDescriptionHe: "ווקסים מקצועיים לעיצוב שיער יומי.",
      metaDescriptionAr: "واكسات احترافية لتصفيف الشعر اليومي.",
    },
    {
      nameHe: "טיפוח זקן ואחרי גילוח",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.BEARD_AFTER_SHAVE],
      imageUrl: "/uploads/seed/categories/after-shave.jpg",
      descriptionHe: "שמנים, קרמים וקולוניות לטיפוח זקן ואחרי גילוח.",
      descriptionAr: "زيوت وكريمات وكولونيا للعناية باللحية وما بعد الحلاقة.",
      isActive: true,
      sortOrder: 70,
      metaTitleHe: "טיפוח זקן ואחרי גילוח",
      metaTitleAr: "العناية باللحية وما بعد الحلاقة",
      metaDescriptionHe: "מוצרי טיפוח לזקן ואפטר שייב איכותיים.",
      metaDescriptionAr: "منتجات عالية الجودة للعناية باللحية وما بعد الحلاقة.",
    },
    {
      nameHe: "ערכות ובאנדלים",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.BUNDLES],
      imageUrl: "/uploads/seed/categories/bundles.jpg",
      descriptionHe: "מארזים ובאנדלים משתלמים של מוצרים משלימים.",
      descriptionAr: "أطقم وباقات موفرة من منتجات متكاملة.",
      isActive: true,
      sortOrder: 80,
      metaTitleHe: "ערכות ובאנדלים",
      metaTitleAr: "أطقم وباقات",
      metaDescriptionHe: "מארזים מוכנים לשגרה מלאה במחיר משתלם.",
      metaDescriptionAr: "باقات جاهزة لروتين كامل بسعر أوفر.",
    },
    {
      nameHe: "תחזוקה וחיטוי למכונות",
      nameAr: CATEGORY_AR_BY_KEY[CATEGORY_KEY.MACHINE_MAINTENANCE],
      imageUrl: "/uploads/seed/categories/maintenance.jpg",
      descriptionHe: "מוצרי תחזוקה, חיטוי ושימון למכונות תספורת וגילוח.",
      descriptionAr: "منتجات صيانة وتعقيم وتشحيم لماكينات القص والحلاقة.",
      isActive: true,
      sortOrder: 90,
      metaTitleHe: "תחזוקה וחיטוי למכונות",
      metaTitleAr: "صيانة وتعقيم الماكينات",
      metaDescriptionHe: "ספרייים ומוצרי תחזוקה לשמירה על ביצועים והיגיינה.",
      metaDescriptionAr: "سبرايات ومنتجات صيانة للحفاظ على الأداء والنظافة.",
    },
  ];

  const categories = await Category.create(sortByOrder(categoriesInput));
  console.log(`✅ Categories created: ${categories.length}`);
  return categories;
}

/* =========================================
   Products (Catalog Set)
========================================= */
async function createProducts(categories) {
  const categoryByKey = buildCategoryMapByKey(categories);

  const catHairClippers = categoryByKey.get(CATEGORY_KEY.HAIR_CLIPPERS);
  const catFoilShavers = categoryByKey.get(CATEGORY_KEY.FOIL_SHAVERS);
  const catTrimmers = categoryByKey.get(CATEGORY_KEY.TRIMMERS);
  const catHairDryersBlowers = categoryByKey.get(CATEGORY_KEY.HAIR_DRYERS_BLOWERS);
  const catElectricHairStylers = categoryByKey.get(CATEGORY_KEY.ELECTRIC_HAIR_STYLERS);
  const catFacialCare = categoryByKey.get(CATEGORY_KEY.FACIAL_CARE);
  const catWaxHairRemoval = categoryByKey.get(CATEGORY_KEY.WAX_HAIR_REMOVAL);
  const catHairCare = categoryByKey.get(CATEGORY_KEY.HAIR_CARE);
  const catStyling = categoryByKey.get(CATEGORY_KEY.STYLING_PRODUCTS);
  const catAfterShave = categoryByKey.get(CATEGORY_KEY.BEARD_AFTER_SHAVE);
  const catBundles = categoryByKey.get(CATEGORY_KEY.BUNDLES);
  const catMachineMaintenance = categoryByKey.get(CATEGORY_KEY.MACHINE_MAINTENANCE);

  const requiredCategoryKeys = [
    CATEGORY_KEY.HAIR_CLIPPERS,
    CATEGORY_KEY.FOIL_SHAVERS,
    CATEGORY_KEY.TRIMMERS,
    CATEGORY_KEY.HAIR_DRYERS_BLOWERS,
    CATEGORY_KEY.ELECTRIC_HAIR_STYLERS,
    CATEGORY_KEY.FACIAL_CARE,
    CATEGORY_KEY.WAX_HAIR_REMOVAL,
    CATEGORY_KEY.HAIR_CARE,
    CATEGORY_KEY.STYLING_PRODUCTS,
    CATEGORY_KEY.BEARD_AFTER_SHAVE,
    CATEGORY_KEY.BUNDLES,
    CATEGORY_KEY.MACHINE_MAINTENANCE,
  ];

  const missingCategoryKeys = requiredCategoryKeys.filter((key) => !categoryByKey.get(key));
  if (missingCategoryKeys.length > 0) {
    throw new Error(`Missing categories (seed integrity error): ${missingCategoryKeys.join(", ")}`);
  }

  const productsInput = [
    // 1
    {
      titleHe: "Kemei KM-1848 מכונת טרימר לאזורים אינטימיים עמידה למים IPX7",
      titleAr: "Kemei KM-1848 ماكينة تشذيب للمناطق الحساسة مقاومة للماء IPX7",
      descriptionHe: "טרימר לאזורים אינטימיים נטען, עמיד למים IPX7, סוללה 600mAh, עד 90 דקות פעולה, תצוגת LCD, טעינה USB ומעמד טעינה.",
      descriptionAr: "ماكينة تشذيب للمناطق الحساسة قابلة للشحن، مقاومة للماء IPX7، بطارية 600mAh، تشغيل حتى 90 دقيقة، شاشة LCD، شحن USB وقاعدة شحن.",
      price: 189.0,
      salePrice: 169.0,
      saleStartAt: nowPlusDays(-3),
      saleEndAt: nowPlusDays(14),
      stock: 35,
      categoryId: catTrimmers._id,
      brand: "Kemei",
      sku: "KEM-KM1848",
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-7),
        notes: "Confirmed by packaging",
        notesAr: "مؤكد من العبوة",
        notesHe: "אושר מתמונות האריזה",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "KEM-KM1848-INT",
        model: "KM-1848",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "Body Grooming Trimmer",
        categorySecondary: "Wet & Dry",
      },
      specs: {
        batteryMah: 600,
        runtimeMin: 90,
        powerW: 5,
        motorSpeedRpmMin: 6500,
        motorSpeedRpmMax: 6500,
        waterproofRating: "IPX7",
        displayType: "LCD",
        chargingType: "USB + Charging Base",
        usageMode: "Cordless",
        bladeMaterial: "Stainless Steel",
      },
      packageIncludes: ["Device", "3 combs (1.5mm / 3–6mm / 9–12mm) = 8 sizes", "Cleaning brush", "Oil", "USB cable", "Charging base", "Manual"],
      packageIncludesAr: [
        "ماكينة ×1",
        "3 أمشاط (1.5mm / 3-6mm / 9-12mm) = 8 قياسات",
        "فرشاة تنظيف ×1",
        "عبوة زيت ×1",
        "كابل USB ×1",
        "قاعدة شحن ×1",
        "دليل استخدام ×1",
      ],
      packageIncludesHe: [
        "מכונה ×1",
        "3 מסרקים (1.5 מ״מ / 3-6 מ״מ / 9-12 מ״מ) = 8 מידות",
        "מברשת ניקוי ×1",
        "בקבוקון שמן ×1",
        "כבל USB ×1",
        "מעמד טעינה ×1",
        "מדריך שימוש ×1",
      ],
      warnings: "AR:\nللاستخدام الخارجي فقط.\nلا يستخدم على جلد ملتهب أو مجروح.\nنظف وجفف الرأس بعد كل استخدام.\nلا تغمر الجهاز بالماء أثناء الشحن.\n\nHE:\nלשימוש חיצוני בלבד.\nאין להשתמש על עור מגורה או פצוע.\nיש לנקות ולייבש את הראש לאחר כל שימוש.\nאין לטבול את המכשיר במים בזמן טעינה.",
      compatibility: {
        replacementHeadCompatibleWith: [],
      },
      publishContent: {
        seoKeywords: ["kemei", "km-1848", "body trimmer", "intimate", "ipx7", "wet & dry"],
        bulletsHe: [
          "עמיד למים IPX7, שימוש יבש או רטוב",
          "סוללה 600mAh, עד 90 דקות פעולה",
          "תצוגת LCD, טעינה USB + מעמד טעינה",
          "3 מסרקים (8 מידות: 1.5 / 3–6 / 9–12 מ״מ)",
          "מתאים לשימוש אישי ואזורים אינטימיים",
        ],
        bulletsAr: [
          "مقاوم للماء IPX7، استخدام جاف أو رطب",
          "بطارية 600mAh، تشغيل حتى 90 دقيقة",
          "شاشة LCD، شحن USB + قاعدة شحن",
          "3 أمشاط (8 قياسات: 1.5 / 3–6 / 9–12 مم)",
          "مناسب للاستخدام الشخصي والمناطق الحساسة",
        ],
        shortDescHe: "דגם KM-1848 מיועד לקיצוץ אישי ואזורים אינטימיים, עמיד למים בתקן IPX7, סוללה 600mAh, זמן עבודה עד 90 דקות, כולל תצוגת LCD ומעמד טעינה.",
        shortDescAr: "ماكينة KM-1848 مخصصة للتشذيب الشخصي والمناطق الحساسة، مقاومة للماء IPX7، بطارية 600mAh، تشغيل حتى 90 دقيقة، مع شاشة LCD وقاعدة شحن.",
      },
      tags: ["kemei", "body-trimmer", "intimate-trimmer", "ipx7", "waterproof", "km-1848"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924264/barber-bang/photo_5829960987115719905_x_1771924263838.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924264/barber-bang/photo_5829960987115719905_x_1771924263838.jpg", altHe: "Kemei KM-1848 טרימר לאזורים אינטימיים", altAr: "Kemei KM-1848 ماكينة تشذيب للمناطق الحساسة", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 15, ratingAvg: 4.4, ratingCount: 9, views7d: 180, cartAdds30d: 32, wishlistAdds30d: 14 },
    },
    // 2
    {
      titleHe: "Kemei מכונת תספורת (דגם לא מזוהה)",
      titleAr: "Kemei ماكينة قص (موديل غير محدد)",
      descriptionHe: "מכונת תספורת Kemei עם בסיס טעינה ועיצוב אחיזה מרקם. דגם לא מזוהה בתמונות.",
      descriptionAr: "ماكينة قص Kemei مع قاعدة شحن وتصميم قبضة محكم. الموديل غير محدد في الصور.",
      price: 219.0,
      stock: 20,
      categoryId: catHairClippers._id,
      brand: "Kemei",
      sku: "KEMEI-CLIPPER-UNKNOWN",
      catalogStatus: "HOLD",
      confidenceGrade: "D",
      verification: {
        isModelVerified: false,
        isCategoryVerified: false,
        verifiedSourcesCount: 0,
        lastVerifiedAt: null,
        notes: "",
        notesAr: "الموديل غير واضح من الصور ويحتاج تأكيد من المورد.",
        notesHe: "הדגם לא ברור מהתמונות ודורש אימות מהספק.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "KEMEI-CLIPPER-UNKNOWN",
        model: "",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "Hair Clipper",
        categorySecondary: "",
      },
      specs: {
        chargingType: "Dock",
        usageMode: "Cordless",
      },
      packageIncludes: [],
      packageIncludesAr: ["قاعدة شحن"],
      packageIncludesHe: ["בסיס טעינה"],
      compatibility: {
        replacementHeadCompatibleWith: [],
      },
      publishContent: {
        seoKeywords: ["kemei", "hair clipper", "cordless", "charging base", "unknown model"],
        bulletsHe: [
          "עיצוב אחיזה מרקם נגד החלקה",
          "בסיס טעינה פרקטי",
          "מתאים לבית ולמקצוענים",
        ],
        bulletsAr: [
          "تصميم مريح بقبضة منقوشة ضد الانزلاق",
          "قاعدة شحن عملية",
          "مناسبة للاستخدام المنزلي والاحترافي",
        ],
        shortDescHe: "מכונת תספורת אלחוטית של Kemei עם בסיס טעינה, הדגם דורש אימות.",
        shortDescAr: "ماكينة قص شعر لاسلكية من Kemei مع قاعدة شحن، الموديل يحتاج تأكيد.",
      },
      tags: ["kemei", "hair-clipper", "unknown-model", "charging-base"],
      images: [{ url: "/uploads/seed/products/02_Kemei_Clipper_Model_Unknown.jpeg", secureUrl: "/uploads/seed/products/02_Kemei_Clipper_Model_Unknown.jpeg", altHe: "Kemei Hair Clipper", altAr: "Kemei Hair Clipper", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 8, ratingAvg: 4.2, ratingCount: 5, views7d: 120, cartAdds30d: 18, wishlistAdds30d: 9 },
    },
    // 3
    {
      titleHe: "Kemei KM-2026 מכונת גילוח פויל 2-ב-1",
      titleAr: "Kemei KM-2026 ماكينة فويل 2 في 1",
      descriptionHe: "מכונת גילוח פויל מקצועית עם 3 מהירויות (6500/7000/7500 RPM), תצוגת LED, טרימר נשלף ו-120 דקות פעולה.",
      descriptionAr: "ماكينة فويل احترافية بـ 3 سرعات (6500/7000/7500 RPM)، شاشة LED، تريمر قابل للسحب و120 دقيقة تشغيل.",
      price: 299.0,
      salePrice: 269.0,
      saleStartAt: nowPlusDays(-2),
      saleEndAt: nowPlusDays(12),
      stock: 40,
      categoryId: catFoilShavers._id,
      brand: "Kemei",
      sku: "TXD-KM-2026",
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 2,
        lastVerifiedAt: nowPlusDays(-2),
        notes: "",
        notesAr: "معلومات مؤكدة من مصادر متعددة موثوقة.",
        notesHe: "מידע מאומת ממקורות מהימנים.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "TXD-KM-2026",
        model: "KM-2026",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "Foil Shaver",
        categorySecondary: "2-in-1 Shaver",
      },
      specs: {
        batteryMah: 1400,
        chargingTimeMin: 120,
        runtimeMin: 120,
        motorSpeedRpmMin: 6500,
        motorSpeedRpmMax: 7500,
        speedModes: 3,
        displayType: "LED",
        foilMaterial: "Titanium",
        chargingType: "USB",
        usageMode: "Corded&Cordless",
      },
      packageIncludes: [
      ],
      packageIncludesAr: [
        "رأس فويل احتياطي",
        "غطاء حماية",
        "فرشاة تنظيف",
        "زيت للشفرات",
        "كابل شحن USB",
        "حقيبة سفر",
      ],
      packageIncludesHe: [
        "ראש פויל חלופי",
        "כיסוי הגנה",
        "מברשת ניקוי",
        "שמן לשימון להבים",
        "כבל טעינת USB",
        "תיק נסיעות",
      ],
      compatibility: {
        replacementHeadCompatibleWith: [],
      },
      publishContent: {
        seoKeywords: ["kemei", "km-2026", "foil shaver", "3 speeds", "led display"],
        bulletsHe: [
          "3 מהירויות 6500/7000/7500 RPM",
          "תצוגת LED לסוללה ולמהירות",
          "סוללת 1400mAh עם 120 דקות עבודה",
          "פויל טיטניום היפואלרגני",
          "טרימר נשלף לעיצוב",
        ],
        bulletsAr: [
          "3 سرعات 6500/7000/7500 RPM",
          "شاشة LED لعرض البطارية والسرعة",
          "بطارية 1400mAh مع 120 دقيقة تشغيل",
          "فويل تيتانيوم مضاد للحساسية",
          "تريمر منبثق للتهذيب السريع",
        ],
        shortDescHe: "מכונת פויל מקצועית 2 ב-1 עם שלוש מהירויות, סוללה חזקה ותצוגת LED.",
        shortDescAr: "ماكينة فويل احترافية 2 في 1 بثلاث سرعات وبطارية قوية وشاشة LED.",
      },
      tags: ["kemei", "foil-shaver", "km-2026", "3-speeds", "led-display", "pop-up-trimmer"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924790/barber-bang/photo_5829960987115719912_y_1771924790128.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924790/barber-bang/photo_5829960987115719912_y_1771924790128.jpg", altHe: "Kemei KM-2026 פויל", altAr: "Kemei KM-2026 فويل", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 28, ratingAvg: 4.7, ratingCount: 19, views7d: 320, cartAdds30d: 64, wishlistAdds30d: 29 },
    },
    // 4
    {
      titleHe: "Kemei KM-2027 מכונת גילוח פויל 2-ב-1",
      titleAr: "Kemei KM-2027 ماكينة فويل 2 في 1",
      descriptionHe: "מכונת גילוח פויל עם תצוגת LCD, 3 מהירויות, סוללה 2000mAh, עמיד במים לשימוש יבש או רטוב.",
      descriptionAr: "ماكينة فويل بشاشة LCD، 3 سرعات، بطارية 2000mAh، مقاومة للماء للاستخدام الجاف أو الرطب.",
      price: 319.0,
      stock: 32,
      categoryId: catFoilShavers._id,
      brand: "Kemei",
      sku: "TXD-KM-2027",
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 2,
        lastVerifiedAt: nowPlusDays(-2),
        notes: "",
        notesAr: "معلومات مؤكدة من مصادر متعددة موثوقة.",
        notesHe: "מידע מאומת ממקורות מהימנים.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "TXD-KM-2027",
        model: "KM-2027",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "Foil Shaver",
        categorySecondary: "Wet & Dry Shaver",
      },
      specs: {
        batteryMah: 2000,
        chargingTimeMin: 120,
        runtimeMin: 120,
        motorSpeedRpmMin: 6500,
        motorSpeedRpmMax: 7500,
        speedModes: 3,
        waterproofRating: "Wet & Dry",
        displayType: "LCD",
        foilMaterial: "Titanium",
        chargingType: "USB",
        usageMode: "Cordless",
      },
      packageIncludes: [
      ],
      packageIncludesAr: [
        "رأس فويل بديل",
        "غطاء حماية",
        "فرشاة تنظيف",
        "زيت للشفرات",
        "كابل USB",
        "حقيبة سفر",
      ],
      packageIncludesHe: [
        "ראש פויל חלופי",
        "כיסוי הגנה",
        "מברשת ניקוי",
        "שמן לשימון להבים",
        "כבל USB",
        "תיק נסיעות",
      ],
      compatibility: {
        replacementHeadCompatibleWith: [],
      },
      publishContent: {
        seoKeywords: ["kemei", "km-2027", "foil shaver", "wet & dry", "lcd display"],
        bulletsHe: [
          "תצוגת LCD ברורה",
          "סוללת 2000mAh עם זמן עבודה ארוך",
          "עמיד למים לשימוש יבש או רטוב",
          "3 מהירויות 6500/7000/7500 RPM",
          "פויל טיטניום היפואלרגני",
        ],
        bulletsAr: [
          "شاشة LCD واضحة",
          "بطارية 2000mAh مع زمن تشغيل طويل",
          "مقاومة للماء للاستخدام الجاف أو الرطب",
          "3 سرعات 6500/7000/7500 RPM",
          "فويل تيتانيوم مضاد للحساسية",
        ],
        shortDescHe: "מכונת פויל עמידה למים עם תצוגת LCD וסוללת 2000mAh.",
        shortDescAr: "ماكينة فويل مقاومة للماء مع شاشة LCD وبطارية 2000mAh.",
      },
      tags: ["kemei", "foil-shaver", "km-2027", "waterproof", "lcd-display", "2000mah"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924760/barber-bang/photo_5829960987115719913_y_1771924759885.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924760/barber-bang/photo_5829960987115719913_y_1771924759885.jpg", altHe: "Kemei KM-2027 פויל", altAr: "Kemei KM-2027 فويل", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 22, ratingAvg: 4.6, ratingCount: 14, views7d: 260, cartAdds30d: 48, wishlistAdds30d: 21 },
    },
    // 5
    {
      titleHe: "Kemei KM-2028 Gold מכונת גילוח פנים נטענת",
      titleAr: "Kemei KM-2028 Gold ماكينة حلاقة وجه قابلة للشحن",
      descriptionHe: "מכונת גילוח פנים נטענת, מתאימה לגילוח יבש או רטוב, ניתנת לשטיפה, תצוגת LCD ושלוש מהירויות (6500/7000/7500 RPM), סוללה 1400mAh, עד 120 דקות פעולה.",
      descriptionAr: "ماكينة حلاقة وجه قابلة للشحن، مناسبة للحلاقة الجافة أو الرطبة، قابلة للغسل، شاشة LCD وثلاث سرعات (6500/7000/7500 دورة/د)، بطارية 1400mAh، حتى 120 دقيقة تشغيل.",
      price: 309.0,
      stock: 25,
      categoryId: catFoilShavers._id,
      brand: "Kemei",
      sku: "KEM-KM2028-GOLD",
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-2),
        notes: "Specs Provided (Ready for listing)",
        notesAr: "مواصفات مُقدَّمة (جاهز للإدراج)",
        notesHe: "מפרט סופק (מוכן לרישום)",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "KEM-KM2028-SHVR",
        model: "KM-2028",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "Face Shaver",
        categorySecondary: "Wet & Dry Shaver",
      },
      specs: {
        batteryMah: 1400,
        chargingTimeMin: 120,
        runtimeMin: 120,
        motorSpeedRpmMin: 6500,
        motorSpeedRpmMax: 7500,
        speedModes: 3,
        powerW: 5,
        waterproofRating: "Wet & Dry",
        displayType: "LCD (speed + battery)",
        chargingType: "USB",
        usageMode: "Cordless",
        bladeMaterial: "Stainless Steel",
        foilMaterial: "Hypoallergenic Titanium",
      },
      packageIncludes: ["Shaver", "Charging cable", "Blade guard", "Cleaning brush", "Carry case", "Manual in English"],
      packageIncludesAr: [
        "ماكينة حلاقة ×1",
        "كابل شحن ×1",
        "غطاء حماية للشفرة ×1",
        "فرشاة تنظيف ×1",
        "حقيبة حمل ×1",
        "دليل استخدام (بالإنجليزية)",
      ],
      packageIncludesHe: [
        "מכונת גילוח ×1",
        "כבל טעינה ×1",
        "מכסה הגנה ללהב ×1",
        "מברשת ניקוי ×1",
        "נרתיק נשיאה ×1",
        "הוראות שימוש (באנגלית)",
      ],
      warnings: "AR:\nللاستخدام الخارجي فقط.\nلا تستخدم على جلد متهيج أو مجروح.\nجفف الجهاز قبل التخزين.\nلا تستخدم شواحن غير مطابقة للمواصفات.\n\nHE:\nלשימוש חיצוני בלבד.\nאין להשתמש על עור מגורה או פצוע.\nיש לייבש את המכשיר לפני אחסון.\nאין להשתמש במטענים שאינם תואמים למפרט.",
      compatibility: {
        replacementHeadCompatibleWith: [],
      },
      publishContent: {
        seoKeywords: ["kemei", "km-2028", "gold", "face shaver", "wet & dry", "lcd", "1400mah"],
        bulletsHe: [
          "מתאימה לשימוש יבש ורטוב",
          "ניתנת לשטיפה במים לניקוי קל",
          "סוללה נטענת 1400mAh",
          "טעינה מלאה תוך שעתיים",
          "זמן עבודה עד 120 דקות",
          "מסך LCD להצגת מהירות וסוללה",
          "3 מהירויות: 6500 / 7000 / 7500 סל״ד",
          "רשת טיטניום היפואלרגנית",
        ],
        bulletsAr: [
          "مناسبة للاستخدام الجاف والرطب",
          "قابلة للغسل والتنظيف بالماء",
          "بطارية قابلة للشحن 1400mAh",
          "شحن كامل خلال ساعتين",
          "تشغيل حتى 120 دقيقة",
          "شاشة LCD لعرض السرعة والبطارية",
          "3 سرعات: 6500 / 7000 / 7500 RPM",
          "شبكة تيتانيوم مضادة للحساسية (Hypoallergenic)",
        ],
        shortDescHe: "מכונת גילוח פנים KM-2028 Gold נטענת, מתאימה לגילוח על עור יבש או רטוב, ניתנת לשטיפה, עם מסך LCD ושלוש מהירויות עבודה.",
        shortDescAr: "ماكينة حلاقة وجه KM-2028 Gold قابلة للشحن، مناسبة للحلاقة على البشرة الجافة أو الرطبة، قابلة للغسل، مع شاشة LCD وثلاث سرعات تشغيل.",
      },
      tags: ["kemei", "km-2028", "foil-shaver", "gold", "face-shaver", "wet-dry", "lcd-display", "1400mah"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924148/barber-bang/photo_5829960987115719914_y_1771924148205.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924148/barber-bang/photo_5829960987115719914_y_1771924148205.jpg", altHe: "Kemei KM-2028 Gold מכונת גילוח פנים", altAr: "Kemei KM-2028 Gold ماكينة حلاقة وجه", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 16, ratingAvg: 4.5, ratingCount: 10, views7d: 200, cartAdds30d: 35, wishlistAdds30d: 16 },
    },
    // 6
    {
      titleHe: "Kemei טרימר T-Blade מקצועי (דגם לא מזוהה)",
      titleAr: "Kemei تريمر T-Blade احترافي (موديل غير محدد)",
      descriptionHe: "טרימר T-Blade לדיוק קווים עם להב DLC, Zero-Gapped, מהירות 6000-8000 RPM (לפי תמונות שיווקיות).",
      descriptionAr: "تريمر T-Blade للتحديد الدقيق بشفرة DLC، Zero-Gapped، سرعة 6000-8000 RPM (حسب الصور التسويقية).",
      price: 239.0,
      stock: 18,
      categoryId: catTrimmers._id,
      brand: "Kemei",
      sku: "KEMEI-TBLADE-UNKNOWN",
      catalogStatus: "HOLD",
      confidenceGrade: "D",
      verification: {
        isModelVerified: false,
        isCategoryVerified: false,
        verifiedSourcesCount: 0,
        lastVerifiedAt: null,
        notes: "",
        notesAr: "الموديل غير واضح والمواصفات من صور تسويقية فقط.",
        notesHe: "הדגם לא ברור והמפרט מבוסס על תמונות שיווקיות בלבד.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "KEMEI-TBLADE-UNKNOWN",
        model: "",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "T-Blade Trimmer",
        categorySecondary: "Precision Trimmer",
      },
      specs: {
        motorSpeedRpmMin: 6000,
        motorSpeedRpmMax: 8000,
        bladeMaterial: "DLC",
      },
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: ["kemei", "t-blade", "precision trimmer", "dlc", "zero-gapped"],
        bulletsAr: [
          "شفرة T للتحديد الدقيق للحواف",
          "Zero-gapped للحلاقة القريبة جداً",
          "شفرة DLC شديدة الصلابة",
          "سرعة عالية 6000-8000 RPM",
          "مثالي للخطوط والتفاصيل",
        ],
        bulletsHe: [
          "להב T לעיצוב קצוות מדויק",
          "Zero-gapped לחיתוך קרוב מאוד",
          "להב DLC קשיח במיוחד",
          "מהירות גבוהה 6000-8000 RPM",
          "מושלם לקווים ופרטים",
        ],
        shortDescAr: "تريمر T-Blade احترافي للتحديد الدقيق، الموديل غير مؤكد.",
        shortDescHe: "טרימר T-Blade מקצועי לעיצוב מדויק, הדגם אינו מאומת.",
      },
      tags: ["kemei", "t-blade", "trimmer", "dlc-blade", "zero-gapped", "precision"],
      images: [{ url: "/uploads/seed/products/06_Kemei_TBlade_Model_Unknown.jpeg", secureUrl: "/uploads/seed/products/06_Kemei_TBlade_Model_Unknown.jpeg", altHe: "Kemei T-Blade טרימר", altAr: "Kemei T-Blade تريمر", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 12, ratingAvg: 4.4, ratingCount: 7, views7d: 155, cartAdds30d: 26, wishlistAdds30d: 12 },
    },
    // 7
    {
      titleHe: "מכונת תספורת אדומה (מותג לא ידוע - Pushon?)",
      titleAr: "ماكينة قص حمراء (علامة غير معروفة - Pushon؟)",
      descriptionHe: "מכונת תספורת אלחוטית אדומה. מותג לא מזוהה בבירור - ייתכן Pushon X9-22. דורש אימות מספק.",
      descriptionAr: "ماكينة قص لاسلكية حمراء. العلامة التجارية غير واضحة - قد تكون Pushon X9-22. تحتاج تأكيد من المورد.",
      price: 179.0,
      stock: 12,
      categoryId: catHairClippers._id,
      brand: "Unknown",
      sku: "PUSHON-X9-22-RED",
      catalogStatus: "HOLD",
      confidenceGrade: "D",
      verification: {
        isModelVerified: false,
        isCategoryVerified: false,
        verifiedSourcesCount: 0,
        lastVerifiedAt: null,
        notes: "",
        notesAr: "الموديل والعلامة التجارية غير مؤكدة، صورة واحدة فقط.",
        notesHe: "הדגם והמותג אינם מאומתים, קיימת רק תמונה אחת.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PUSHON-X9-22-RED",
        model: "",
        productLine: "",
      },
      classification: {
        categoryPrimary: "Hair Clipper",
        categorySecondary: "",
      },
      specs: {},
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: ["hair clipper", "unknown brand", "cordless", "red clipper"],
        bulletsAr: [
          "ماكينة قص شعر لاسلكية باللون الأحمر",
          "العلامة التجارية غير مؤكدة (قد تكون Pushon)",
          "الموديل غير واضح ويحتاج تأكيد",
        ],
        bulletsHe: [
          "מכונת תספורת אלחוטית בצבע אדום",
          "מותג לא מאומת (ייתכן Pushon)",
          "הדגם אינו ברור ודורש אימות",
        ],
        shortDescAr: "ماكينة قص شعر حمراء بدون معلومات مؤكدة عن الموديل.",
        shortDescHe: "מכונת תספורת אדומה ללא מידע מאומת על הדגם.",
      },
      tags: ["pushon", "red-clipper", "unknown-brand", "needs-verification"],
      images: [{ url: "/uploads/seed/products/07_Unknown_Red_Clipper.jpeg", secureUrl: "/uploads/seed/products/07_Unknown_Red_Clipper.jpeg", altHe: "מכונת תספורת אדומה", altAr: "ماكينة قص حمراء", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 4, ratingAvg: 3.8, ratingCount: 3, views7d: 65, cartAdds30d: 8, wishlistAdds30d: 3 },
    },
    // 8
    {
      titleHe: "Pier Jouliet שמפו נגד קשקשים TherapyCare 500 מ״ל",
      titleAr: "Pier Jouliet شامبو ضد القشرة TherapyCare 500 مل",
      descriptionHe: "שמפו טיפולי נגד קשקשים לשיער רגיל עד שמן. מכיל 500 מ״ל למשפחה שלמה.",
      descriptionAr: "شامبو علاجي ضد القشرة للشعر العادي إلى الدهني. يحتوي على 500 مل للعائلة كلها.",
      price: 69.0,
      stock: 120,
      categoryId: catHairCare._id,
      brand: "Pier Jouliet",
      sku: "PJ-ANTI-DANDRUFF-500ML",
      unit: "ml",
      netQuantity: 500,
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 2,
        lastVerifiedAt: nowPlusDays(-5),
        notes: "",
        notesAr: "مؤكد من متاجر متعددة مع وضوح الاسم والحجم.",
        notesHe: "מאומת ממספר חנויות עם שם ונפח ברורים.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-ANTI-DANDRUFF-500ML",
        model: "PJ-ANTI-DANDRUFF-500ML",
        productLine: "TherapyCare",
      },
      classification: {
        categoryPrimary: "Anti Dandruff Shampoo",
        categorySecondary: "Haircare",
      },
      specs: {},
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: ["pier jouliet", "anti dandruff", "shampoo", "therapycare", "500ml"],
        bulletsAr: [
          "شامبو علاجي ضد القشرة للشعر العادي إلى الدهني",
          "تركيبة علاجية تنظف فروة الرأس بعمق",
          "يقلل الحكة والتهيّج",
          "حجم اقتصادي 500 مل",
          "مناسب للاستخدام المنتظم",
        ],
        bulletsHe: [
          "שמפו טיפולי נגד קשקשים לשיער רגיל עד שמן",
          "נוסחה טיפולית לניקוי עמוק של הקרקפת",
          "מפחית גרד וגירוי",
          "נפח חסכוני 500 מ״ל",
          "מתאים לשימוש קבוע",
        ],
        shortDescAr: "شامبو علاجي ضد القشرة من Pier Jouliet بحجم 500 مل.",
        shortDescHe: "שמפו טיפולי נגד קשקשים של Pier Jouliet בנפח 500 מ״ל.",
      },
      tags: ["pier-jouliet", "shampoo", "anti-dandruff", "therapycare", "500ml"],
      images: [{ url: "/uploads/seed/products/08_PierJouliet_AntiDandruff_500ml.jpeg", secureUrl: "/uploads/seed/products/08_PierJouliet_AntiDandruff_500ml.jpeg", altHe: "שמפו נגד קשקשים 500ml", altAr: "شامبو ضد القشرة 500مل", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 42, ratingAvg: 4.7, ratingCount: 28, views7d: 380, cartAdds30d: 78, wishlistAdds30d: 35 },
    },
    // 9
    {
      titleHe: "Pier Jouliet מסכת שיער ללא שטיפה מס' 10 - 400 מ״ל",
      titleAr: "Pier Jouliet ماسك شعر بدون شطف رقم 10 - 400 مل",
      descriptionHe: "מסכת שיער Leave-in לטיפוח עמוק, ריכוך ונוחות סידור. 400 מ״ל.",
      descriptionAr: "ماسك شعر Leave-in للترطيب العميق والتنعيم وسهولة التصفيف. 400 مل.",
      price: 79.0,
      stock: 85,
      categoryId: catHairCare._id,
      brand: "Pier Jouliet",
      sku: "PJ-LEAVEIN-NO10-400ML",
      unit: "ml",
      netQuantity: 400,
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 2,
        lastVerifiedAt: nowPlusDays(-5),
        notes: "",
        notesAr: "مؤكد من متجر موثوق مع تفاصيل واضحة.",
        notesHe: "מאומת מחנות אמינה עם פרטים ברורים.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-LEAVEIN-NO10-400ML",
        model: "PJ-LEAVEIN-NO10-400ML",
        productLine: "No.10",
      },
      classification: {
        categoryPrimary: "Leave-in Hair Mask",
        categorySecondary: "Haircare",
      },
      specs: {},
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: ["pier jouliet", "leave-in", "hair mask", "no rinse", "400ml"],
        bulletsAr: [
          "ماسك شعر لا يُشطف للترطيب والتنعيم",
          "يرطب بعمق ويقلل التقصف والجفاف",
          "سهل الاستخدام ولا يثقل الشعر",
          "مناسب لجميع أنواع الشعر",
          "حجم 400 مل",
        ],
        bulletsHe: [
          "מסכת שיער ללא שטיפה ללחות וריכוך",
          "מרכך לעומק ומפחית יובש ושבירה",
          "קל לשימוש ואינו מכביד על השיער",
          "מתאים לכל סוגי השיער",
          "נפח 400 מ״ל",
        ],
        shortDescAr: "ماسك Leave-in رقم 10 للترطيب العميق والتنعيم، 400 مل.",
        shortDescHe: "מסכת Leave-in מספר 10 ללחות עמוקה וריכוך, 400 מ״ל.",
      },
      tags: ["pier-jouliet", "leave-in", "hair-mask", "no-rinse", "400ml"],
      images: [{ url: "/uploads/seed/products/09_PierJouliet_LeaveIn_400ml.jpeg", secureUrl: "/uploads/seed/products/09_PierJouliet_LeaveIn_400ml.jpeg", altHe: "מסכת Leave-in 400ml", altAr: "ماسك Leave-in 400مل", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 28, ratingAvg: 4.5, ratingCount: 18, views7d: 240, cartAdds30d: 47, wishlistAdds30d: 22 },
    },
    // 10
    {
      titleHe: "Pier Jouliet Clay Wax - ווקס חימר לעיצוב טבעי",
      titleAr: "Pier Jouliet Clay Wax - واكس طيني للتصفيف الطبيعي",
      descriptionHe: "ווקס חימר לעיצוב שיער עם גימור טבעי ואחיזה בינונית עד חזקה.",
      descriptionAr: "واكس طيني لتصفيف الشعر بلمسة طبيعية وثبات متوسط إلى قوي.",
      price: 75.0,
      stock: 95,
      categoryId: catStyling._id,
      brand: "Pier Jouliet",
      sku: "PJ-CLAY-WAX",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "C",
      verification: {
        isModelVerified: false,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-6),
        notes: "",
        notesAr: "ظهر على الموقع الرسمي لكن الحجم غير محدد.",
        notesHe: "הופיע באתר הרשמי אך הנפח לא צוין.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-CLAY-WAX",
        model: "PJ-CLAY-WAX",
        productLine: "Clay Wax",
      },
      classification: {
        categoryPrimary: "Clay Wax",
        categorySecondary: "Styling",
      },
      specs: {},
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: ["pier jouliet", "clay wax", "styling", "matte finish"],
        bulletsAr: [
          "واكس طيني بلمعة مطفية إلى خفيفة",
          "ثبات متوسط إلى قوي طوال اليوم",
          "يعطي تكستشر طبيعي وحجم",
          "مثالي للشعر القصير إلى المتوسط",
          "سهل التطبيق وإعادة التصفيف",
        ],
        bulletsHe: [
          "ווקס חימר בגימור מט עד מבריק קל",
          "אחיזה בינונית עד חזקה לאורך היום",
          "מעניק טקסטורה טבעית ונפח",
          "מתאים לשיער קצר עד בינוני",
          "קל לעיצוב מחדש",
        ],
        shortDescAr: "واكس طيني للتصفيف بثبات قوي ولمعة مطفية.",
        shortDescHe: "ווקס חימר לעיצוב עם אחיזה חזקה וגימור מט.",
      },
      tags: ["pier-jouliet", "clay-wax", "styling", "matte-finish", "medium-hold"],
      images: [{ url: "/uploads/seed/products/10_PierJouliet_ClayWax.jpeg", secureUrl: "/uploads/seed/products/10_PierJouliet_ClayWax.jpeg", altHe: "Clay Wax", altAr: "Clay Wax", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 32, ratingAvg: 4.6, ratingCount: 21, views7d: 280, cartAdds30d: 55, wishlistAdds30d: 26 },
    },
    // 11
    {
      titleHe: "Pier Jouliet קולוניה אחרי גילוח",
      titleAr: "Pier Jouliet كولونيا بعد الحلاقة",
      descriptionHe: "קולוניה מרעננת לשימוש אחרי גילוח עם ניחוח נקי ומתמשך.",
      descriptionAr: "كولونيا منعشة للاستخدام بعد الحلاقة برائحة نظيفة ومستمرة.",
      price: 65.0,
      stock: 110,
      categoryId: catAfterShave._id,
      brand: "Pier Jouliet",
      sku: "PJ-AFTER-SHAVE-COLOGNE",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "C",
      verification: {
        isModelVerified: false,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-6),
        notes: "",
        notesAr: "ظهر في متاجر وصور حقيقية لكن الحجم غير محدد.",
        notesHe: "הופיע בחנויות ותמונות אך הנפח לא צוין.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-AFTER-SHAVE-COLOGNE",
        model: "PJ-AFTER-SHAVE-COLOGNE",
        productLine: "After Shave",
      },
      classification: {
        categoryPrimary: "After Shave Cologne",
        categorySecondary: "After Shave",
      },
      specs: {},
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: ["pier jouliet", "after shave", "cologne", "eau de cologne"],
        bulletsAr: [
          "رائحة منعشة ومميزة بعد الحلاقة",
          "يهدئ البشرة ويقلل التهيج",
          "يمكن استخدامه كعطر خفيف",
          "ثبات جيد للرائحة",
          "مثالي للاستخدام اليومي",
        ],
        bulletsHe: [
          "ניחוח רענן אחרי גילוח",
          "מרגיע את העור ומפחית גירוי",
          "מתאים גם כבושם קל",
          "עמידות ריח טובה",
          "מתאים לשימוש יומיומי",
        ],
        shortDescAr: "كولونيا بعد الحلاقة برائحة منعشة وهادئة للبشرة.",
        shortDescHe: "קולוניה אחרי גילוח בניחוח מרענן ומרגיע לעור.",
      },
      tags: ["pier-jouliet", "after-shave", "cologne", "eau-de-cologne", "fresh"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927708/barber-bang/photo_5814267292580253024_x_1771927707834.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927708/barber-bang/photo_5814267292580253024_x_1771927707834.jpg", altHe: "After Shave Cologne", altAr: "After Shave Cologne", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 26, ratingAvg: 4.4, ratingCount: 15, views7d: 205, cartAdds30d: 42, wishlistAdds30d: 19 },
    },
    // 12
    {
      titleHe: "Pier Jouliet Aqua Wax 250 מ״ל - ווקס מבריק",
      titleAr: "Pier Jouliet Aqua Wax 250 مل - واكس لامع",
      descriptionHe: "ווקס על בסיס מים לעיצוב עם ברק גבוה ושליטה קלה. 250 מ״ל.",
      descriptionAr: "واكس مائي للتصفيف بلمعان عالٍ وتحكم سهل. 250 مل.",
      price: 72.0,
      stock: 75,
      categoryId: catStyling._id,
      brand: "Pier Jouliet",
      sku: "PJ-AQUA-WAX-250ML",
      unit: "ml",
      netQuantity: 250,
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 2,
        lastVerifiedAt: nowPlusDays(-5),
        notes: "",
        notesAr: "مؤكد من صور واضحة مع الحجم.",
        notesHe: "מאומת מתמונות ברורות עם נפח.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-AQUA-WAX-250ML",
        model: "PJ-AQUA-WAX-250ML",
        productLine: "Aqua Wax",
      },
      classification: {
        categoryPrimary: "Aqua Wax",
        categorySecondary: "Styling",
      },
      specs: {},
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: ["pier jouliet", "aqua wax", "water based", "high shine", "250ml"],
        bulletsAr: [
          "واكس مائي سهل الغسل بالماء فقط",
          "لمعة عالية جداً لمظهر رطب",
          "ثبات متوسط إلى قوي",
          "مثالي لتسريحات الـ Slick Back و Side Part",
          "حجم 250 مل",
        ],
        bulletsHe: [
          "ווקס על בסיס מים שנשטף בקלות",
          "ברק גבוה למראה רטוב",
          "אחיזה בינונית עד חזקה",
          "מושלם לתסרוקות Slick Back ו-Side Part",
          "נפח 250 מ״ל",
        ],
        shortDescAr: "واكس مائي بلمعة عالية وحجم 250 مل.",
        shortDescHe: "ווקס מימי עם ברק גבוה בנפח 250 מ״ל.",
      },
      tags: ["pier-jouliet", "aqua-wax", "water-based", "high-shine", "250ml"],
      images: [{ url: "/uploads/seed/products/12_PierJouliet_AquaWax_250ml.jpeg", secureUrl: "/uploads/seed/products/12_PierJouliet_AquaWax_250ml.jpeg", altHe: "Aqua Wax 250ml", altAr: "Aqua Wax 250مل", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 21, ratingAvg: 4.4, ratingCount: 13, views7d: 190, cartAdds30d: 35, wishlistAdds30d: 16 },
    },
    // 13
    {
      titleHe: "Pier Jouliet Booster Wax 100 גרם - מט",
      titleAr: "Pier Jouliet Booster Wax 100 غرام - مطفي",
      descriptionHe: "ווקס מט ללא ברק (Without Shine) לעיצוב יומי בטקסטורה טבעית. 100 גרם.",
      descriptionAr: "واكس مطفي بدون لمعان (Without Shine) للتصفيف اليومي بتكستشر طبيعي. 100 غرام.",
      price: 68.0,
      stock: 100,
      categoryId: catStyling._id,
      brand: "Pier Jouliet",
      sku: "PJ-BOOSTER-MATTE-100G",
      unit: "g",
      netQuantity: 100,
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 2,
        lastVerifiedAt: nowPlusDays(-5),
        notes: "",
        notesAr: "مؤكد من صور واضحة مع نص without shine.",
        notesHe: "מאומת מתמונות ברורות עם Without Shine.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-BOOSTER-MATTE-100G",
        model: "PJ-BOOSTER-MATTE-100G",
        productLine: "Booster Matte Wax",
      },
      classification: {
        categoryPrimary: "Matte Wax",
        categorySecondary: "Styling",
      },
      specs: {},
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: ["pier jouliet", "booster wax", "matte", "no shine", "100g"],
        bulletsAr: [
          "لمعة مطفية تماماً بدون لمعان",
          "ثبات قوي جداً طوال اليوم",
          "تكستشر طبيعي وحجم ممتاز",
          "مناسب لجميع أنواع الشعر",
          "حجم 100 غرام",
        ],
        bulletsHe: [
          "גימור מט מלא ללא ברק",
          "אחיזה חזקה מאוד לאורך היום",
          "טקסטורה טבעית ונפח מצוין",
          "מתאים לכל סוגי השיער",
          "נפח 100 גרם",
        ],
        shortDescAr: "واكس مطفي قوي جداً بلمسة طبيعية، 100 غرام.",
        shortDescHe: "ווקס מט חזק במיוחד במראה טבעי, 100 גרם.",
      },
      tags: ["pier-jouliet", "booster-wax", "matte-finish", "no-shine", "100g"],
      images: [{ url: "/uploads/seed/products/13_PierJouliet_BoosterWax_100g.jpeg", secureUrl: "/uploads/seed/products/13_PierJouliet_BoosterWax_100g.jpeg", altHe: "Booster Wax 100g מט", altAr: "Booster Wax 100غ مطفي", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 38, ratingAvg: 4.7, ratingCount: 24, views7d: 310, cartAdds30d: 68, wishlistAdds30d: 31 },
    },
    // 13-A
    {
      titleHe: "Booster (בוסטר) ווקס לשיער מט",
      titleAr: "بوستر (Booster) واكس شعر مطفي",
      descriptionHe:
        "Booster הוא ווקס ייחודי לעיצוב השיער במראה מט, ללא ברק. מעניק אחיזה ועיצוב נקיים עם גימור טבעי־מאט. מורחים כמות קטנה על שיער לח או יבש ומעצבים לפי הסגנון הרצוי. מתאים לשימוש יומיומי וליצירת מראה מסודר ואלגנטי ללא תחושת ברק.",
      descriptionAr:
        "Booster هو واكس مميز لتصفيف الشعر بمظهر مطفي بدون لمعان. يمنح تثبيتاً وتصفيفاً نظيفاً مع لمسة طبيعية غير لامعة. تُوضع كمية صغيرة على الشعر الجاف أو الرطب ثم يُصفف حسب الشكل المطلوب. مناسب للاستخدام اليومي للحصول على ستايل مرتب بدون لمعان.",
      price: 80.0,
      stock: 90,
      categoryId: catStyling._id,
      brand: "Pier Jouliet",
      sku: "PJ-BOOSTER-MATTE-CLASSIC",
      unit: "g",
      netQuantity: null,
      sizeLabel: null,
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Unit price kept as provided: 6.67 ILS / 10g (total net weight not specified).",
        notesAr: "تم الإبقاء على سعر الوحدة كما ورد: 6.67 شيكل لكل 10 غرام (الوزن الإجمالي غير مذكور).",
        notesHe: "מחיר היחידה נשמר כפי שסופק: 6.67₪ ל-10 גרם (המשקל הכולל לא צוין).",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-BOOSTER-MATTE-CLASSIC",
        model: "BOOSTER-MATTE-CLASSIC",
        productLine: "Booster",
      },
      classification: {
        categoryPrimary: "Matte Hair Wax",
        categorySecondary: "Hair Styling",
      },
      specs: {},
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: [
          "ווקס לשיער",
          "עיצוב שיער",
          "ווקס מט",
          "Booster",
          "בוסטר",
          "מוצרי עיצוב שיער",
          "אחיזה לשיער",
          "סטיילינג",
          "מראה מט",
          "ללא ברק",
          "واكس شعر",
          "تصفيف الشعر",
          "واكس مطفي",
          "Booster",
          "بوستر",
          "منتجات تصفيف",
          "تثبيت الشعر",
          "ستايلينغ",
          "بدون لمعان",
          "مظهر مطفي",
          "6.67 ₪ / 10g",
        ],
        bulletsHe: [
          "ווקס ייחודי לעיצוב שיער בגימור מט (ללא ברק).",
          "מתאים לשיער לח או יבש.",
          "מריחה קלה: כמות קטנה מספיקה.",
          "מאפשר עיצוב טבעי ומסודר לשימוש יומיומי.",
          "מחיר ל־10 גרם: 6.67₪ (כפי שסופק).",
        ],
        bulletsAr: [
          "واكس لتصفيف الشعر بلمسة مطفية بدون لمعان.",
          "مناسب للشعر الجاف أو الرطب.",
          "كمية صغيرة تكفي لنتيجة واضحة.",
          "مثالي للاستخدام اليومي وتصفيف طبيعي مرتب.",
          "السعر لكل 10 غرام: 6.67₪ (كما ورد).",
        ],
        shortDescHe: "ווקס לשיער בגימור מט – עיצוב ואחיזה ללא ברק.",
        shortDescAr: "واكس شعر بمظهر مطفي – تثبيت وتصفيف بدون لمعان.",
      },
      tags: ["pier-jouliet", "booster", "matte-wax", "hair-styling", "no-shine"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927464/barber-bang/photo_5814267292580253027_x_1771927464310.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927464/barber-bang/photo_5814267292580253027_x_1771927464310.jpg", altHe: "Booster ווקס מט לשיער", altAr: "بوستر واكس شعر مطفي", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 13-B
    {
      titleHe: "חימר לשיער (Clay)",
      titleAr: "طين للشعر (Clay)",
      descriptionHe:
        "חימר (Clay) הוא ווקס ייחודי לעיצוב השיער במראה מט ללא ברק. מעניק עיצוב נקי וגימור טבעי, ומתאים לשימוש יומיומי ליצירת סטייל מסודר ומודגש ללא תחושת ברק.\nהוראות שימוש: למרוח כמות קטנה על שיער לח או יבש ולעצב כרצונך.",
      descriptionAr:
        "طين الشعر (Clay) هو واكس/طين مميز لتصفيف الشعر بلمسة مطفية بدون لمعان. يمنح مظهراً طبيعياً وتصفيفاً مرتباً للاستخدام اليومي بدون لمعان زائد.\nطريقة الاستخدام: ضع كمية صغيرة على الشعر الجاف أو الرطب ثم صفّف كما تريد.",
      price: 70.0,
      stock: 90,
      categoryId: catStyling._id,
      brand: "Pier Jouliet",
      sku: "PJ-CLAY-MATTE-CLASSIC",
      unit: "g",
      netQuantity: null,
      sizeLabel: null,
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Unit price kept as provided: 58.33 ILS / 100g (total net weight not specified).",
        notesAr: "تم الإبقاء على سعر الوحدة كما ورد: 58.33 شيكل لكل 100 غرام (الوزن الإجمالي غير مذكور).",
        notesHe: "מחיר היחידה נשמר כפי שסופק: 58.33₪ ל-100 גרם (המשקל הכולל לא צוין).",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-CLAY-MATTE-CLASSIC",
        model: "CLAY-MATTE-CLASSIC",
        productLine: "Clay",
      },
      classification: {
        categoryPrimary: "Clay / Matte Wax",
        categorySecondary: "Hair Styling",
      },
      specs: {},
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: [
          "חימר לשיער",
          "Clay",
          "ווקס לשיער",
          "עיצוב שיער",
          "חימר מט",
          "מוצרי סטיילינג",
          "אחיזה לשיער",
          "ללא ברק",
          "מראה מט",
          "טיפוח שיער",
          "طين للشعر",
          "Clay",
          "واكس شعر",
          "تصفيف الشعر",
          "مظهر مطفي",
          "بدون لمعان",
          "تثبيت الشعر",
          "منتجات تصفيف",
          "ستايلينغ",
          "عناية الشعر",
          "58.33 ₪ / 100g",
        ],
        bulletsHe: [
          "חימר/ווקס לעיצוב שיער בגימור מט (ללא ברק).",
          "מתאים לשיער לח או יבש.",
          "מריחה קלה – כמות קטנה מספיקה.",
          "מאפשר עיצוב טבעי ומסודר לשימוש יומיומי.",
          "מחיר ל־100 גרם: 58.33₪ (כפי שסופק).",
        ],
        bulletsAr: [
          "طين/واكس لتصفيف الشعر بلمسة مطفية بدون لمعان.",
          "مناسب للشعر الجاف أو الرطب.",
          "كمية صغيرة تكفي لنتيجة واضحة.",
          "مثالي لتصفيف يومي طبيعي ومرتب.",
          "السعر لكل 100 غرام: 58.33₪ (كما ورد).",
        ],
        shortDescHe: "חימר לשיער בגימור מט – עיצוב ואחיזה ללא ברק.",
        shortDescAr: "طين للشعر بمظهر مطفي – تصفيف وتثبيت بدون لمعان.",
      },
      tags: ["pier-jouliet", "clay", "matte-wax", "hair-styling", "no-shine"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927414/barber-bang/photo_5814267292580253026_x_1771927414037.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927414/barber-bang/photo_5814267292580253026_x_1771927414037.jpg", altHe: "חימר לשיער", altAr: "طين للشعر", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 14
    {
      titleHe: "Kemei KM-1735 מכונת דירוג מקצועית נטענת",
      titleAr: "Kemei KM-1735 ماكينة تدريج احترافية قابلة للشحن",
      descriptionHe: "מכונת דירוג/קווי מתאר/גימור עם מנוע Brushless, 7000–9000 RPM, סוללה 2500mAh, עד 280 דקות פעולה, תצוגת LCD, 8 מסרקים, מעמד טעינה וכבל USB.",
      descriptionAr: "ماكينة تدريج وتحديد وجيمور بمحرك Brushless، 7000–9000 دورة/د، بطارية 2500mAh، تشغيل حتى 280 دقيقة، شاشة LCD، 8 أمشاط، قاعدة شحن وكابل USB.",
      price: 279.0,
      stock: 20,
      categoryId: catHairClippers._id,
      brand: "Kemei",
      sku: "KEM-KM1735",
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Confirmed by packaging",
        notesAr: "مؤكد من العبوة",
        notesHe: "אושר מתמונות האריזה",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "KEM-KM1735-FADE",
        model: "KM-1735",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "Fade / Grading Clipper",
        categorySecondary: "Rechargeable / Cordless",
      },
      specs: {
        batteryMah: 2500,
        chargingTimeMin: 210,
        runtimeMin: 280,
        voltageV: 3.7,
        powerW: 5,
        motorSpeedRpmMin: 7000,
        motorSpeedRpmMax: 9000,
        chargingType: "USB 5V=1A",
        displayType: "LCD / charging indicator",
        usageMode: "Cordless",
      },
      packageIncludes: ["Device", "8 combs (1.5–18mm)", "Blade guard", "Cleaning brush", "Oil", "USB cable", "Charging base", "Manual"],
      packageIncludesAr: [
        "ماكينة ×1",
        "أمشاط ×8: 1.5/3/4.5/6/9/12/15/18 مم",
        "غطاء حماية ×1",
        "فرشاة تنظيف ×1",
        "عبوة زيت ×1",
        "كابل USB ×1",
        "قاعدة شحن ×1",
        "دليل استخدام ×1",
      ],
      packageIncludesHe: [
        "מכונה ×1",
        "מסרקים ×8: 1.5/3/4.5/6/9/12/15/18 מ״מ",
        "מכסה הגנה ×1",
        "מברשת ניקוי ×1",
        "בקבוקון שמן ×1",
        "כבל USB ×1",
        "מעמד טעינה ×1",
        "מדריך שימוש ×1",
      ],
      warnings: "AR:\nللاستخدام الخارجي فقط.\nلا يستخدم على جلد ملتهب أو مجروح.\nنظف الشفرة بعد كل استخدام.\nاستخدم شاحن USB 5V=1A.\nيحفظ بعيداً عن متناول الأطفال.\n\nHE:\nלשימוש חיצוני בלבד.\nאין להשתמש על עור מגורה או פצוע.\nיש לנקות את הלהב אחרי כל שימוש.\nיש להשתמש במטען USB 5V=1A.\nלהרחיק מהישג ידם של ילדים.",
      publishContent: {
        seoKeywords: ["kemei", "km-1735", "fade", "grading", "brushless", "2500mah"],
        bulletsAr: [
          "محرك Brushless، تنظيم سرعة 7000–9000 RPM",
          "بطارية 2500mAh، تشغيل حتى 280 دقيقة",
          "شحن 3.5 ساعة، USB 5V=1A وقاعدة شحن",
          "شاشة LCD / مؤشر شحن",
          "8 أمشاط: 1.5 حتى 18 ملم",
          "للتدرج والتحديد والجيمور والفينيشن",
        ],
        bulletsHe: [
          "מנוע Brushless, ויסות מהירות 7000–9000 RPM",
          "סוללה 2500mAh, עד 280 דקות פעולה",
          "טעינה 3.5 שעות, USB 5V=1A ומעמד טעינה",
          "תצוגת LCD / חיווי טעינה",
          "8 מסרקים: 1.5–18 מ״מ",
          "לדירוגים, קווי מתאר, גימור ופיניש",
        ],
        shortDescAr: "ماكينة KM-1735 مخصصة للتدريج والتحديد والجيمور، بمحرك Brushless، بطارية 2500mAh، تشغيل حتى 280 دقيقة، مع قاعدة شحن وكابل USB.",
        shortDescHe: "דגם KM-1735 מיועד לדירוגים, קווי מתאר וגימור, עם מנוע Brushless, סוללה 2500mAh, זמן עבודה עד 280 דקות, כולל מעמד טעינה וכבל USB.",
      },
      variants: [
        { variantKey: "color:yellow", sku: "KEM-KM1735-YLW", stock: 10, attributes: [{ key: "color", type: "text", valueKey: "yellow", value: "Yellow" }] },
        { variantKey: "color:green", sku: "KEM-KM1735-GRN", stock: 10, attributes: [{ key: "color", type: "text", valueKey: "green", value: "Green" }] },
      ],
      tags: ["kemei", "km-1735", "fade", "grading", "brushless", "rechargeable"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924096/barber-bang/photo_5829960987115719973_y_1771924096237.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924096/barber-bang/photo_5829960987115719973_y_1771924096237.jpg", altHe: "Kemei KM-1735 מכונת דירוג", altAr: "Kemei KM-1735 ماكينة تدريج", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 15
    {
      titleHe: "Kemei KM-1838 מכונת טרימר לאזורים אינטימיים עמידה למים IPX7",
      titleAr: "Kemei KM-1838 ماكينة تشذيب المناطق الحساسة مقاومة للماء IPX7",
      descriptionHe: "טרימר אישי נטען (שימוש רטוב/יבש). עמיד למים IPX7, סוללה 600mAh, זמן עבודה כ-90 דקות, טעינה 1.5 שעות דרך USB 5V=1A, חיווי טעינה.",
      descriptionAr: "ماكينة تشذيب شخصية قابلة للشحن (استخدام رطب/جاف). مقاومة للماء IPX7، بطارية 600mAh، تشغيل حتى 90 دقيقة تقريبًا، شحن 1.5 ساعة عبر USB 5V=1A، مؤشر شحن.",
      price: 199.0,
      salePrice: 179.0,
      saleStartAt: nowPlusDays(-1),
      saleEndAt: nowPlusDays(10),
      stock: 45,
      categoryId: catTrimmers._id,
      brand: "Kemei",
      sku: "KEM-KM1838-TRIM",
      barcode: "6955549318380",
      unit: null,
      netQuantity: null,
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 2,
        lastVerifiedAt: nowPlusDays(-4),
        notes: "Confirmed by packaging.",
        notesAr: "مؤكد من العبوة.",
        notesHe: "אושר מתמונות האריזה.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "KEM-KM1838-INT",
        model: "KM-1838",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "Body Grooming Trimmer",
        categorySecondary: "Wet & Dry Trimmer",
      },
      specs: {
        batteryMah: 600,
        chargingTimeMin: 90,
        runtimeMin: 90,
        voltageV: 3.7,
        powerW: 5,
        waterproofRating: "IPX7",
        bladeMaterial: "Ceramic",
        chargingType: "USB 5V=1A",
        usageMode: "Cordless",
        displayType: "LCD/Charging Indicator",
      },
      packageIncludes: ["KM-1838 device", "USB cable"],
      packageIncludesAr: [
        "جهاز KM-1838",
        "كابل USB",
        "(أي ملحقات إضافية تُثبت بعد فتح عينة)",
      ],
      packageIncludesHe: [
        "מכשיר KM-1838",
        "כבל USB",
        "(אביזרים נוספים יאושרו לאחר פתיחת יחידת דוגמה)",
      ],
      usage: "AR:\nاشحن الجهاز كاملًا قبل أول استخدام.\nاستخدم على بشرة نظيفة وجافة أو رطبة حسب الحاجة.\nمرر الجهاز بلطف عكس اتجاه نمو الشعر.\nنظف الرأس بعد الاستخدام وجففه جيدًا.\n\nHE:\nיש לטעון את המכשיר במלואו לפני שימוש ראשון.\nלהשתמש על עור נקי, יבש או רטוב לפי הצורך.\nלהעביר בעדינות נגד כיוון צמיחת השיער.\nלנקות את הראש לאחר השימוש ולייבש היטב.",
      warnings: "AR:\nللاستخدام الخارجي فقط.\nلا يستخدم على جلد متهيج أو مجروح.\nلا تغمر الجهاز في الماء أثناء الشحن.\nيحفظ بعيدًا عن متناول الأطفال.\n\nHE:\nלשימוש חיצוני בלבד.\nאין להשתמש על עור מגורה או פצוע.\nאין לטבול את המכשיר במים בזמן טעינה.\nלשמור הרחק מהישג ידם של ילדים.",
      publishContent: {
        seoKeywords: ["kemei", "km-1838", "body trimmer", "ipx7", "personal trimmer", "intimate", "wet dry"],
        bulletsAr: [
          "مقاومة للماء IPX7 (استخدام رطب/جاف)",
          "بطارية 600mAh قابلة لإعادة الشحن",
          "تشغيل حتى 90 دقيقة تقريبًا",
          "شحن خلال 1.5 ساعة",
          "شحن USB بمدخل 5V=1A",
          "مؤشر تشغيل/شحن",
          "مناسبة للاستخدام الشخصي والمناطق الحساسة",
        ],
        bulletsHe: [
          "עמידות למים IPX7 (שימוש רטוב/יבש)",
          "סוללה נטענת 600mAh",
          "זמן עבודה של עד כ-90 דקות",
          "זמן טעינה של 1.5 שעות",
          "טעינת USB בקלט 5V=1A",
          "חיווי פעולה/טעינה",
          "מתאימה לשימוש אישי ואזורים אינטימיים",
        ],
        shortDescAr: "ماكينة KM-1838 مخصصة للتشذيب الشخصي والمناطق الحساسة، مقاومة للماء IPX7، تعمل حتى 90 دقيقة تقريبًا بعد شحن 1.5 ساعة عبر USB.",
        shortDescHe: "דגם KM-1838 מיועד לקיצוץ אישי ואזורים אינטימיים, עמיד למים בתקן IPX7, זמן עבודה של כ-90 דקות לאחר טעינה של 1.5 שעות דרך USB.",
      },
      tags: ["kemei", "body-trimmer", "km-1838", "ipx7-waterproof", "ceramic-blade", "led-light", "usb"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924216/barber-bang/photo_5829960987115719906_y_1771924216393.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924216/barber-bang/photo_5829960987115719906_y_1771924216393.jpg", altHe: "Kemei KM-1838 טרימר גוף", altAr: "Kemei KM-1838 تريمر الجسم", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 24, ratingAvg: 4.6, ratingCount: 16, views7d: 280, cartAdds30d: 52, wishlistAdds30d: 24 },
    },
    // 16
    {
      titleHe: "Kemei KM-1693 מכונת טרימר מקצועית Type-C (6 מהירויות)",
      titleAr: "Kemei KM-1693 ماكينة تحديد شعر احترافية Type-C (6 سرعات)",
      descriptionHe: "טרימר/קליפר נטען לדיוק וגימור, סוללה 1200mAh, עד 120 דקות פעולה, טעינת Type-C, תצוגה דיגיטלית ו-6 מהירויות 6000–7000 RPM.",
      descriptionAr: "ماكينة تحديد/قص قابلة للشحن للتحديد والجيمور، بطارية 1200mAh، تشغيل حتى 120 دقيقة، شحن Type-C، شاشة رقمية و6 سرعات 6000–7000 دورة/د.",
      price: 259.0,
      stock: 40,
      categoryId: catTrimmers._id,
      brand: "Kemei",
      sku: "KEM-KM1693",
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-6),
        notes: "Confirmed by packaging",
        notesAr: "مؤكد من العبوة",
        notesHe: "אושר מתמונות האריזה",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "KEM-KM1693-TRIM",
        model: "KM-1693",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "Professional Hair Trimmer",
        categorySecondary: "Outline & Finishing",
      },
      specs: {
        batteryMah: 1200,
        runtimeMin: 120,
        powerW: 5,
        motorSpeedRpmMin: 6000,
        motorSpeedRpmMax: 7000,
        speedModes: 6,
        chargingType: "USB Type-C",
        displayType: "Digital battery/power display",
        usageMode: "Cordless",
      },
      packageIncludes: ["Device", "USB cable", "3 combs (1/2/3mm)", "Head guard", "Cleaning brush", "Oil", "Manual"],
      packageIncludesAr: [
        "ماكينة ×1",
        "كابل USB ×1",
        "3 أمشاط: 1/2/3 مم",
        "غطاء حماية للرأس ×1",
        "فرشاة تنظيف ×1",
        "عبوة زيت ×1",
        "دليل استخدام ×1",
      ],
      packageIncludesHe: [
        "מכונה ×1",
        "כבל USB ×1",
        "3 מסרקים: 1/2/3 מ״מ",
        "מכסה הגנה לראש ×1",
        "מברשת ניקוי ×1",
        "בקבוקון שמן ×1",
        "מדריך שימוש ×1",
      ],
      warnings: "AR:\nللاستخدام الخارجي فقط.\nلا يستخدم على جلد ملتهب أو مجروح.\nنظف الشفرة بعد كل استخدام.\nاستخدم كابل/شاحن Type-C مناسب.\nيحفظ بعيداً عن متناول الأطفال.\n\nHE:\nלשימוש חיצוני בלבד.\nאין להשתמש על עור מגורה או פצוע.\nיש לנקות את הלהב לאחר כל שימוש.\nיש להשתמש בכבל/מטען Type-C מתאים.\nלהרחיק מהישג ידם של ילדים.",
      publishContent: {
        seoKeywords: ["kemei", "km-1693", "hair trimmer", "type-c", "6 speeds", "outline finishing"],
        bulletsAr: [
          "6 سرعات حتى 7000 RPM",
          "بطارية 1200mAh، تشغيل حتى 120 دقيقة",
          "شحن USB Type-C",
          "شاشة رقمية لعرض البطارية والطاقة",
          "3 أمشاط: 1 / 2 / 3 مم",
          "للتحديد والجيمور والقص",
        ],
        bulletsHe: [
          "6 מהירויות עד 7000 RPM",
          "סוללה 1200mAh, עד 120 דקות פעולה",
          "טעינת USB Type-C",
          "תצוגה דיגיטלית לסוללה והספק",
          "3 מסרקים: 1/2/3 מ״מ",
          "לדיוק, גימור ותספורת",
        ],
        shortDescAr: "ماكينة KM-1693 للتحديد والجيمور، بطارية 1200mAh، تشغيل حتى 120 دقيقة، شحن Type-C، شاشة رقمية و6 سرعات حتى 7000RPM.",
        shortDescHe: "KM-1693 מיועדת לדיוק וגימור, עם סוללה 1200mAh, זמן עבודה עד 120 דקות, טעינת Type-C, תצוגה דיגיטלית ו-6 מהירויות עד 7000RPM.",
      },
      variants: [
        { variantKey: "color:green", sku: "KEM-KM1693-GRN", stock: 10, attributes: [{ key: "color", type: "text", valueKey: "green", value: "Green" }] },
        { variantKey: "color:yellow", sku: "KEM-KM1693-YLW", stock: 10, attributes: [{ key: "color", type: "text", valueKey: "yellow", value: "Yellow" }] },
        { variantKey: "color:blue", sku: "KEM-KM1693-BLU", stock: 10, attributes: [{ key: "color", type: "text", valueKey: "blue", value: "Blue" }] },
        { variantKey: "color:purple", sku: "KEM-KM1693-PUR", stock: 10, attributes: [{ key: "color", type: "text", valueKey: "purple", value: "Purple" }] },
      ],
      tags: ["kemei", "km-1693", "hair-trimmer", "type-c", "6-speeds", "outline-finishing"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771923922/barber-bang/photo_5829960987115719984_y_1771923921736.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771923922/barber-bang/photo_5829960987115719984_y_1771923921736.jpg", altHe: "Kemei KM-1693 מכונת טרימר Type-C", altAr: "Kemei KM-1693 ماكينة تحديد Type-C", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 14, ratingAvg: 4.3, ratingCount: 8, views7d: 175, cartAdds30d: 28, wishlistAdds30d: 13 },
    },
    // 17
    {
      titleHe: "Kemei KM-1808 טרימר שיער מקצועי",
      titleAr: "Kemei KM-1808 ماكينة تحديد شعر احترافية",
      descriptionHe: "טרימר שיער מקצועי נטען. סוללה 2500mAh, עד 260 דקות פעולה, 7500 RPM, 6 מסרקים (1.5–12 מ\"מ), גוף מתכת, תצוגת טעינה. מתאים: קווי מתאר, זקן/שפם, גילוף קל, פיניש.",
      descriptionAr: "ماكينة تحديد شعر احترافية قابلة لإعادة الشحن. بطارية 2500mAh، تشغيل حتى 260 دقيقة، 7500 دورة/د، 6 أمشاط (1.5–12 ملم)، هيكل معدني، مؤشر شحن. مناسبة: تحديد الحواف، لحية/شارب، نقش خفيف، فينيشن.",
      price: 229.0,
      stock: 15,
      categoryId: catTrimmers._id,
      brand: "Kemei",
      sku: "KEM-KM1808-TRIM",
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Confirmed by packaging photos. Specs from box.",
        notesAr: "مؤكد من صور العبوة. المواصفات من العلبة.",
        notesHe: "אושר מתמונות האריזה. מפרט מהקופסה.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "KEM-KM1808-TRIM",
        model: "KM-1808",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "Professional Hair Trimmer",
        categorySecondary: "Finishing & Engraving",
      },
      specs: {
        batteryMah: 2500,
        runtimeMin: 260,
        chargingTimeMin: 180,
        voltageV: 3.7,
        powerW: 12,
        motorSpeedRpmMin: 7500,
        motorSpeedRpmMax: 7500,
        chargingType: "USB 5V1A + charging base",
        usageMode: "Cordless",
        bladeMaterial: "Blue zirconium ceramic blade",
        displayType: "Power Display / Charging Indicator",
      },
      packageIncludes: ["6 combs (1.5/3/4.5/6/9/12 mm)", "Blade guard", "Charging base", "USB cable", "Cleaning brush", "Oil", "Manual"],
      packageIncludesAr: ["6 أمشاط: 1.5 / 3 / 4.5 / 6 / 9 / 12 ملم", "غطاء حماية للشفرة", "قاعدة شحن", "كابل USB", "فرشاة تنظيف", "زيت", "دليل استخدام"],
      packageIncludesHe: ["6 מסרקים: 1.5/3/4.5/6/9/12 מ\"מ", "מגן להב", "בסיס טעינה", "כבל USB", "מברשת ניקוי", "שמן", "מדריך שימוש"],
      publishContent: {
        seoKeywords: ["kemei", "km-1808", "hair trimmer", "professional", "rechargeable", "line-up", "finishing", "engraving"],
        bulletsAr: [
          "بطارية 2500mAh، تشغيل حتى 260 دقيقة",
          "سرعة محرك 7500 دورة/د (خمول)",
          "6 أمشاط: 1.5 / 3 / 4.5 / 6 / 9 / 12 ملم",
          "هيكل معدني، مؤشر طاقة/شحن",
          "شحن USB 5V1A + قاعدة شحن",
          "مناسب: تحديد الحواف، تشذيب اللحية والشارب، فينيشن ونقش خفيف",
        ],
        bulletsHe: [
          "סוללה 2500mAh, עד 260 דקות פעולה",
          "7500 RPM (סרקון)",
          "6 מסרקים: 1.5/3/4.5/6/9/12 מ\"מ",
          "גוף מתכת, תצוגת טעינה",
          "טעינה USB 5V1A + בסיס טעינה",
          "מתאים: קווי מתאר, זקן/שפם, פיניש וגילוף קל",
        ],
        shortDescAr: "ماكينة تحديد شعر احترافية Kemei KM-1808 قابلة لإعادة الشحن، 2500mAh، حتى 260 دقيقة، 6 أمشاط. مؤكد من صور العبوة.",
        shortDescHe: "טרימר שיער מקצועי Kemei KM-1808 נטען, 2500mAh, עד 260 דקות, 6 מסרקים. מאושר מתמונות האריזה.",
      },
      tags: ["kemei", "km-1808", "hair-trimmer", "professional", "rechargeable", "line-up", "finishing", "engraving"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771923990/barber-bang/photo_5829960987115719985_y_1771923989111.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771923990/barber-bang/photo_5829960987115719985_y_1771923989111.jpg", altHe: "Kemei KM-1808 טרימר שיער", altAr: "Kemei KM-1808 ماكينة تحديد شعر", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 18
    {
      titleHe: "Kemei KM-1868 מכונת תספורת מקצועית",
      titleAr: "Kemei KM-1868 ماكينة حلاقة احترافية",
      descriptionHe: "מכונת תספורת/טרימר מקצועית נטענת. להב DLC, מהירות 6000–8000 RPM, סוללה 1400mAh, עד 120 דקות פעולה, תצוגת LED, טעינה USB. לשימוש: עיצוב קווים, פיניש, דרגות, זקן וקצוות.",
      descriptionAr: "ماكينة حلاقة/تريمر احترافية قابلة لإعادة الشحن. شفرة DLC، سرعة 6000–8000 دورة/د، بطارية 1400mAh، تشغيل حتى 120 دقيقة، شاشة LED، شحن USB. للاستخدام: تحديد، فينيشن، تدريجات، لحية وحواف.",
      price: 149.0,
      salePrice: 129.0,
      saleStartAt: nowPlusDays(-2),
      saleEndAt: nowPlusDays(15),
      stock: 38,
      categoryId: catHairClippers._id,
      brand: "Kemei",
      sku: "LFJ-KM-1868",
      catalogStatus: "READY",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 2,
        lastVerifiedAt: nowPlusDays(-3),
        notes: "",
        notesAr: "الهوية مؤكدة من العبوة. المنتج ماكينة حلاقة/تريمر وليس جهاز عناية بالوجه.",
        notesHe: "זהות מאומתת מהאריזה. המוצר מכונת תספורת/טרימר ולא מכשיר טיפוח פנים.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "LFJ-KM-1868",
        model: "KM-1868",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "Hair Trimmer / Finishing Clipper",
        categorySecondary: "Professional Rechargeable Hair Clipper",
      },
      specs: {
        motorSpeedRpmMin: 6000,
        motorSpeedRpmMax: 8000,
        batteryMah: 1400,
        chargingTimeMin: 120,
        runtimeMin: 120,
        voltageV: 3.2,
        powerW: 5,
        chargingType: "USB 5V-1A",
        bladeMaterial: "DLC fixed blade",
        displayType: "LED",
      },
      packageIncludes: [],
      packageIncludesAr: [
        "ماكينة KM-1868",
        "قاعدة شحن",
        "كابل USB",
        "4 أمشاط (1.5 / 3 / 4.5 / 6 مم)",
        "فرشاة تنظيف",
        
        "دليل استخدام",
      ],
      packageIncludesHe: [
        "מכונת KM-1868",
        "בסיס טעינה",
        "כבל USB",
        "4 מסרקים (1.5 / 3 / 4.5 / 6 מ\"מ)",
        "מברשת ניקוי",
        "מדריך שימוש",
      ],
      publishContent: {
        seoKeywords: ["kemei", "km-1868", "hair clipper", "trimmer", "rechargeable", "dlc blade", "professional"],
        bulletsAr: [
          "سرعة محرك 6000–8000 دورة/دقيقة",
          "بطارية 1400mAh وتشغيل حتى 120 دقيقة",
          "شفرة DLC ثابتة، شاشة LED",
          "شحن USB 5V-1A، زمن شحن 2 ساعة",
          "4 أمشاط (1.5 / 3 / 4.5 / 6 مم)، لتحديد وفينيشن ولحية وحواف",
        ],
        bulletsHe: [
          "מהירות מנוע 6000–8000 RPM",
          "סוללה 1400mAh ועד 120 דקות פעולה",
          "להב DLC קבוע, תצוגת LED",
          "טעינה USB 5V-1A, טעינה 2 שעות",
          "4 מסרקים (1.5/3/4.5/6 מ\"מ), לעיצוב קווים, פיניש, זקן וקצוות",
        ],
        shortDescAr: "ماكينة حلاقة احترافية Kemei KM-1868 قابلة لإعادة الشحن، شفرة DLC، 6000–8000 دورة/د، حتى 120 دقيقة تشغيل.",
        shortDescHe: "מכונת תספורת מקצועית Kemei KM-1868 נטענת, להב DLC, 6000–8000 RPM, עד 120 דקות פעולה.",
      },
      tags: ["kemei", "km-1868", "hair-clipper", "trimmer", "dlc-blade", "rechargeable", "led-display"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924296/barber-bang/photo_5829960987115719904_y_1771924296380.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924296/barber-bang/photo_5829960987115719904_y_1771924296380.jpg", altHe: "Kemei KM-1868 מכונת תספורת", altAr: "Kemei KM-1868 ماكينة حلاقة", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 19, ratingAvg: 4.5, ratingCount: 12, views7d: 220, cartAdds30d: 38, wishlistAdds30d: 18 },
    },
    // 19
    {
      titleHe: "Kemei KM-1867 מכונת טרימר מקצועית עם להב DLC",
      titleAr: "Kemei KM-1867 ماكينة تحديد شعر احترافية DLC",
      descriptionHe: "טרימר מקצועי במהירות גבוהה 9000 RPM, להב DLC, סוללה 2500mAh, זמן עבודה עד 180 דקות, מעמד טעינה + כבל, תצוגת LCD, גוף מתכת מלא.",
      descriptionAr: "ماكينة تحديد احترافية بسرعة عالية 9000 RPM، شفرة DLC، بطارية 2500mAh، تشغيل حتى 180 دقيقة، قاعدة شحن + كابل، شاشة LCD، هيكل معدني كامل.",
      price: 249.0,
      stock: 15,
      categoryId: catTrimmers._id,
      brand: "Kemei",
      sku: "KEM-KM1867-TRIM",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Supplier Spec Provided (until packaging documentation)",
        notesAr: "مواصفات المورد متوفرة (حتى توثيق العبوة)",
        notesHe: "מפרט ספק (עד תיעוד אריזה)",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "KEM-KM1867-TRIM",
        model: "KM-1867",
        productLine: "Kemei",
      },
      classification: {
        categoryPrimary: "Professional Hair Trimmer",
        categorySecondary: "Line-up / Finishing",
      },
      specs: {
        batteryMah: 2500,
        runtimeMin: 180,
        chargingTimeMin: 180,
        powerW: 5,
        motorSpeedRpmMin: 9000,
        motorSpeedRpmMax: 9000,
        chargingType: "Charging Base + Cable",
        usageMode: "Cordless",
        bladeMaterial: "Ceramic / DLC",
        displayType: "LCD",
      },
      packageIncludes: ["Device", "Charging cable", "Charging base", "Cleaning brush", "Combs 1.5–24mm"],
      packageIncludesAr: [
        "ماكينة ×1",
        "كابل شحن ×1",
        "قاعدة شحن ×1",
        "فرشاة تنظيف ×1",
        "أمشاط: 1.5 / 3 / 4.5 / 6 / 9 / 12 / 15 / 18 / 21 / 24 مم",
      ],
      packageIncludesHe: [
        "מכונה ×1",
        "כבל טעינה ×1",
        "מעמד טעינה ×1",
        "מברשת ניקוי ×1",
        "מסרקים: 1.5 / 3 / 4.5 / 6 / 9 / 12 / 15 / 18 / 21 / 24 מ״מ",
      ],
      warnings: "AR:\nلا يتضمن زيتًا بسبب قيود الشحن الجوي.\n\nHE:\nלא כולל שמן עקב מגבלות שילוח אווירי.",
      publishContent: {
        seoKeywords: ["kemei", "km-1867", "professional hair trimmer", "dlc", "9000 rpm", "rechargeable"],
        bulletsAr: [
          "سرعة 9000 RPM",
          "شفرة DLC / سيراميك",
          "بطارية 2500mAh، تشغيل حتى 180 دقيقة",
          "شحن 3 ساعات، قاعدة شحن + كابل",
          "شاشة LCD، هيكل معدني كامل",
          "10 أمشاط: 1.5 حتى 24 ملم",
        ],
        bulletsHe: [
          "9000 RPM",
          "להב DLC / קרמיקה",
          "סוללה 2500mAh, עד 180 דקות פעולה",
          "טעינה 3 שעות, מעמד טעינה + כבל",
          "תצוגת LCD, גוף מתכת מלא",
          "10 מסרקים: 1.5–24 מ״מ",
        ],
        shortDescAr: "ماكينة تحديد احترافية بسرعة عالية 9000 RPM، شفرة DLC، بطارية 2500mAh، وتشغيل حتى 180 دقيقة مع قاعدة شحن.",
        shortDescHe: "טרימר מקצועי במהירות גבוהה 9000RPM, להב DLC, סוללה 2500mAh וזמן עבודה עד 180 דקות עם מעמד טעינה.",
      },
      tags: ["kemei", "km-1867", "hair-trimmer", "professional", "dlc-blade", "rechargeable", "lcd-display"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924031/barber-bang/photo_5829960987115719976_y_1771924030771.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771924031/barber-bang/photo_5829960987115719976_y_1771924030771.jpg", altHe: "Kemei KM-1867 טרימר", altAr: "Kemei KM-1867 ماكينة تحديد", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 20
    {
      titleHe: "מארז קרטין לשיער",
      titleAr: "مجموعة كيراتين للشعر",
      descriptionHe:
        "מארז קרטין מקיף לטיפוח שיער יבש/צבוע/פגום. המארז כולל 3 מוצרים בנפח 500 מ\"ל לכל מוצר, ומספק שגרת טיפוח מלאה המסייעת לניקוי עדין, להזנה, לריכוך ולשיפור מראה השיער והברק. מתאים לשימוש יומיומי או לפי הצורך, ומהווה פתרון פרקטי וחסכוני למי שמעדיף לקבל את כל שלבי הטיפוח במארז אחד.",
      descriptionAr:
        "مجموعة كيراتين متكاملة للعناية بالشعر الجاف/المصبوغ/التالف. تضم 3 منتجات بحجم 500 مل لكل منتج، لتوفير روتين عناية كامل يساعد على تنظيف الشعر بلطف، ترطيب وتنعيم الخصلات، ودعم مظهر أكثر صحة ولمعاناً. مناسبة للاستخدام اليومي أو حسب الحاجة، وتعد خياراً عملياً واقتصادياً لمن يريد نتائج واضحة ضمن مجموعة واحدة.",
      stock: 60,
      categoryId: catBundles._id,
      brand: "Pier Jouliet",
      sku: "PJ-KERATIN-KIT-3X500ML",
      price: 270.0,
      sizeLabel: "3 x 500ml",
      unit: "set",
      netQuantity: 3,
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Bundle content provided as publish-ready catalog copy.",
        notesAr: "تم اعتماد محتوى المجموعة كنص نشر رسمي في الكتالوج.",
        notesHe: "תוכן המארז אושר כטקסט קטלוג מוכן לפרסום.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-KERATIN-KIT-3X500ML",
        model: "KERATIN-KIT-3X500ML",
        productLine: "Keratin Care",
      },
      classification: {
        categoryPrimary: "Keratin Hair Care Kit",
        categorySecondary: "Kit / Bundle",
      },
      specs: {},
      packageIncludes: [
        "Keratin shampoo for dry/colored/damaged hair (500ml)",
        "Keratin hair cream for dry/colored/damaged hair (500ml)",
        "Keratin hair mask for dry/colored/damaged hair (500ml)",
      ],
      packageIncludesAr: [
        "شامبو كيراتين للشعر الجاف/المصبوغ/التالف (500 مل)",
        "كريم شعر كيراتين للشعر الجاف/المصبوغ/التالف (500 مل)",
        "ماسك شعر كيراتين للشعر الجاف/المصبوغ/التالف (500 مل)",
      ],
      packageIncludesHe: [
        "שמפו קרטין לשיער יבש/צבוע/פגום (500 מ\"ל)",
        "קרם שיער קרטין לשיער יבש/צבוע/פגום (500 מ\"ל)",
        "מסכת שיער קרטין לשיער יבש/צבוע/פגום (500 מ\"ל)",
      ],
      publishContent: {
        seoKeywords: [
          "keratin",
          "keratin kit",
          "hair care bundle",
          "3x500ml",
          "كيراتين",
          "مجموعة كيراتين",
          "شامبو كيراتين",
          "ماسك كيراتين",
          "كريم كيراتين",
          "عناية الشعر",
          "ترطيب الشعر",
          "نعومة الشعر",
          "شعر تالف",
          "شعر مصبوغ",
          "شعر جاف",
          "קרטין",
          "מארז קרטין",
          "שמפו קרטין",
          "מסכת שיער",
          "קרם שיער",
          "טיפוח שיער",
          "שיער יבש",
          "שיער צבוע",
          "שיער פגום",
          "הזנה לשיער",
          "לחות לשיער",
          "ריכוך שיער",
          "שיקום שיער",
        ],
        bulletsAr: [
          "مجموعة متكاملة من 3 منتجات للعناية بالشعر الجاف/المصبوغ/التالف.",
          "تشمل: شامبو + كريم شعر + ماسك، كل منتج بحجم 500 مل.",
          "تساعد على التغذية والترطيب والنعومة وتحسين مظهر الشعر.",
          "حل عملي واقتصادي لروتين عناية كامل ضمن مجموعة واحدة.",
        ],
        bulletsHe: [
          "מארז מקיף של 3 מוצרים לטיפוח שיער יבש/צבוע/פגום.",
          "כולל: שמפו + קרם שיער + מסכת שיער, 500 מ\"ל לכל מוצר.",
          "מסייע להזנה, לחות, ריכוך ושיפור מראה השיער.",
          "פתרון משתלם לשגרת טיפוח מלאה במארז אחד.",
        ],
        shortDescAr: "مجموعة كيراتين للشعر الجاف/المصبوغ/التالف – 3 منتجات × 500 مل.",
        shortDescHe: "מארז קרטין לשיער יבש/צבוע/פגום – 3 מוצרים × 500 מ\"ל.",
      },
      tags: ["pier-jouliet", "keratin", "hair-care", "kit", "bundle", "3x500ml", "dry-hair", "colored-hair", "damaged-hair"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925378/barber-bang/photo_5814267292580253006_x__2__1771925378197.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925378/barber-bang/photo_5814267292580253006_x__2__1771925378197.jpg",
          altHe: "מארז קרטין לשיער",
          altAr: "مجموعة كيراتين للشعر",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 21
    {
      titleHe: "מארז מפנק לגבר - טיפוח שיער וזקן",
      titleAr: "مجموعة عناية فاخرة للرجل - للشعر واللحية",
      descriptionHe:
        "מארז הטיפוח המושלם לשיער ולזקן, לשגרה יומיומית נוחה ומסודרת. המארז כולל מסרק עץ איכותי ומברשת ייעודית לעיצוב וסירוק יומיומי, שמפו לגבר לניקוי ורענון, שמן לזקן וקרם לזקן המועשרים בשמנים ובוויטמינים. השילוב בין המוצרים מעניק רכות וברק, תורם לעיצוב טבעי ומראה מטופח, ומסייע לבריאות העור והשיער—ללא תחושת שמנוניות, עם תוצאות מורגשות יום אחרי יום.",
      descriptionAr:
        "مجموعة العناية المثالية للشعر واللحية لروتين يومي مرتب وسهل. تحتوي المجموعة على مشط خشبي عالي الجودة وفرشاة مخصصة لتصفيف وتمشيط يومي، بالإضافة إلى شامبو للرجال للتنظيف والانتعاش، وزيت وكريم للّحية مدعّمين بالزيوت والفيتامينات. يعمل هذا المزيج على منح نعومة ولمعاناً وتصفيفاً طبيعياً ومظهراً أكثر عناية، مع دعم صحة الجلد والشعر—بدون إحساس دهني، وبنتائج يمكن ملاحظتها يوماً بعد يوم.",
      price: 260.0,
      stock: 50,
      categoryId: catBundles._id,
      brand: "Pier Jouliet",
      sku: "PJ-MEN-GROOMING-KIT-5PCS",
      unit: "set",
      netQuantity: 5,
      sizeLabel: "5 items",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Bundle copy and components approved for catalog publishing.",
        notesAr: "تم اعتماد نص المجموعة ومكوناتها للنشر في الكتالوج.",
        notesHe: "תוכן המארז והרכיבים אושרו לפרסום בקטלוג.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-MEN-GROOMING-KIT",
        model: "MEN-GROOMING-KIT-5PCS",
        productLine: "Men Grooming",
      },
      classification: {
        categoryPrimary: "Men Hair & Beard Care Kit",
        categorySecondary: "Kit / Bundle",
      },
      specs: {},
      packageIncludes: [
        "Premium wooden comb",
        "Beard styling/brush",
        "Men shampoo (cleanse & refresh)",
        "Beard oil enriched with oils and vitamins",
        "Beard cream enriched with oils and vitamins",
      ],
      packageIncludesAr: [
        "مشط خشبي عالي الجودة",
        "فرشاة لتصفيف وتمشيط اللحية",
        "شامبو للرجال (تنظيف وانتعاش)",
        "زيت لحية غني بالزيوت والفيتامينات",
        "كريم لحية غني بالزيوت والفيتامينات",
      ],
      packageIncludesHe: [
        "מסרק עץ איכותי",
        "מברשת לעיצוב וסירוק זקן",
        "שמפו לגבר (ניקוי ורענון)",
        "שמן לזקן מועשר בשמנים ובוויטמינים",
        "קרם לזקן מועשר בשמנים ובוויטמינים",
      ],
      publishContent: {
        seoKeywords: [
          "מארז לגבר",
          "מארז טיפוח לגבר",
          "טיפוח זקן",
          "שמן לזקן",
          "קרם לזקן",
          "שמפו לגבר",
          "מסרק עץ",
          "מברשת זקן",
          "עיצוב זקן",
          "טיפוח שיער לגבר",
          "مجموعة عناية للرجال",
          "مجموعة للرجل",
          "عناية اللحية",
          "زيت اللحية",
          "كريم اللحية",
          "شامبو للرجال",
          "مشط خشبي",
          "فرشاة لحية",
          "تصفيف اللحية",
          "عناية شعر الرجال",
        ],
        bulletsHe: [
          "מארז טיפוח מלא לשיער ולזקן לשימוש יומיומי.",
          "כולל מסרק עץ איכותי ומברשת ייעודית לעיצוב וסירוק.",
          "שמפו לגבר לניקוי ורענון.",
          "שמן וקרם לזקן מועשרים בשמנים ובוויטמינים להזנה וריכוך.",
          "מעניק רכות, ברק ועיצוב טבעי ללא תחושת שמנוניות.",
        ],
        bulletsAr: [
          "مجموعة عناية متكاملة للشعر واللحية للاستخدام اليومي.",
          "تشمل مشطاً خشبياً عالي الجودة وفرشاة لتصفيف وتمشيط اللحية.",
          "شامبو للرجال للتنظيف والانتعاش.",
          "زيت وكريم لحية غنيّان بالزيوت والفيتامينات للترطيب والتنعيم.",
          "تمنح نعومة ولمعاناً وتصفيفاً طبيعياً بدون إحساس دهني.",
        ],
        shortDescHe: "מארז טיפוח לגבר לשיער ולזקן – סירוק, ניקוי, הזנה ועיצוב טבעי ללא שמנוניות.",
        shortDescAr: "مجموعة عناية للرجل للشعر واللحية – تمشيط وتنظيف وتغذية وتصفيف طبيعي بدون دهنية.",
      },
      tags: [
        "pier-jouliet",
        "men-grooming-kit",
        "beard-care",
        "hair-and-beard",
        "beard-oil",
        "beard-cream",
        "bundle",
      ],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925501/barber-bang/photo_5814267292580253028_x_1771925500823.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925501/barber-bang/photo_5814267292580253028_x_1771925500823.jpg",
          altHe: "מארז מפנק לגבר",
          altAr: "مجموعة عناية فاخرة للرجل",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 22
    {
      titleHe: "שמן לזקן ולשפם (פייר ג׳ולייט)",
      titleAr: "زيت للّحية والشارب (بيير جولييت)",
      descriptionHe:
        "שמן לזקן ולשפם של פייר ג׳ולייט נספג היטב בשיער ואינו משאיר תחושת שמנוניות. מועשר בשמנים ובוויטמינים המסייעים לשמירה על בריאות העור והשיער. מעניק לשיער ברק, מרכך ומטפח אותו, ותורם לתחושת חיוניות בעור הפנים. מתאים לשימוש יומיומי לשמירה על מראה מסודר, רך ומטופח של הזקן והשפם.",
      descriptionAr:
        "زيت للّحية والشارب من بيير جولييت يمتصه الشعر بسرعة ولا يترك إحساساً دهنياً. غني بالزيوت والفيتامينات التي تساعد في الحفاظ على صحة الجلد والشعر. يمنح الشعر لمعاناً، ينعّمه ويغذّيه، ويدعم حيوية بشرة الوجه. مناسب للاستخدام اليومي للحصول على مظهر مرتب وناعم ومعتنى به للّحية والشارب.",
      price: 90.0,
      stock: 90,
      categoryId: catAfterShave._id,
      brand: "Pier Jouliet",
      sku: "PJ-BEARD-MUSTACHE-OIL-50ML",
      unit: "ml",
      netQuantity: 50,
      sizeLabel: "50 ml",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Unit price kept at 30 ILS per 10ml as provided in source text (arithmetically inconsistent with 90 ILS / 50ml).",
        notesAr: "تم الإبقاء على سعر الوحدة 30 شيكل لكل 10 مل كما ورد بالنص، مع وجود تعارض حسابي مقابل سعر 90 شيكل لحجم 50 مل.",
        notesHe: "מחיר היחידה נשמר כ-30₪ לכל 10 מ״ל כפי שמופיע בטקסט, למרות סתירה חשבונית מול 90₪ ל-50 מ״ל.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-BEARD-MUSTACHE-OIL",
        model: "BEARD-MUSTACHE-OIL-50ML",
        productLine: "Men Grooming",
      },
      classification: {
        categoryPrimary: "Beard & Mustache Oil",
        categorySecondary: "Men Grooming",
      },
      specs: {},
      packageIncludes: ["Beard & mustache oil bottle (50ml)"],
      packageIncludesAr: ["زيت للّحية والشارب (50 مل)"],
      packageIncludesHe: ["שמן לזקן ולשפם (50 מ״ל)"],
      publishContent: {
        seoKeywords: [
          "שמן לזקן",
          "שמן לשפם",
          "טיפוח זקן",
          "טיפוח לגבר",
          "פייר ג׳ולייט",
          "שמן לזקן ולשפם",
          "ברק לזקן",
          "ריכוך זקן",
          "ללא שמנוניות",
          "ויטמינים לזקן",
          "زيت اللحية",
          "زيت للّحية والشارب",
          "عناية اللحية",
          "عناية الرجال",
          "بيير جولييت",
          "زيت لحية بدون دهنية",
          "لمعان اللحية",
          "تنعيم اللحية",
          "فيتامينات",
          "ترطيب اللحية",
          "30 ₪ / 10ml",
        ],
        bulletsHe: [
          "נספג היטב ואינו משאיר תחושת שמנוניות.",
          "מועשר בשמנים ובוויטמינים לעור ולשיער.",
          "מעניק ברק, מרכך ומסייע לסידור הזקן והשפם.",
          "תורם לחיוניות עור הפנים ולמראה מטופח.",
          "מתאים לשימוש יומיומי.",
          "מחיר ל-10 מ״ל: 30₪ (כפי שמופיע בטקסט; קיימת סתירה חשבונית מול 90₪ ל-50 מ״ל).",
        ],
        bulletsAr: [
          "سريع الامتصاص ولا يترك ملمساً دهنياً.",
          "غني بالزيوت والفيتامينات لدعم صحة البشرة والشعر.",
          "يمنح لمعاناً ويساعد على تنعيم وترتيب اللحية والشارب.",
          "يساهم في حيوية بشرة الوجه ومظهر معتنى به.",
          "مناسب للاستخدام اليومي.",
          "سعر الوحدة لكل 10 مل: 30₪ (كما ورد؛ يوجد تعارض حسابي مع سعر 90₪).",
        ],
        shortDescHe: "שמן לזקן ולשפם נספג מהר – ברק, ריכוך וטיפוח ללא תחושת שמנוניות.",
        shortDescAr: "زيت للّحية والشارب سريع الامتصاص – لمعان وتنعيم وعناية بدون إحساس دهني.",
      },
      tags: [
        "pier-jouliet",
        "beard-oil",
        "mustache-oil",
        "men-grooming",
        "non-greasy",
        "beard-care",
      ],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925555/barber-bang/photo_5814267292580253022_x_1771925554635.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925555/barber-bang/photo_5814267292580253022_x_1771925554635.jpg",
          altHe: "שמן לזקן ולשפם",
          altAr: "زيت للّحية والشارب",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 23
    {
      titleHe: "שעווה לגבר להסרת שיער גוף",
      titleAr: "شمع للرجال لإزالة شعر الجسم",
      descriptionHe:
        "שעווה לגבר בנוסחה ייחודית ובניחוח גברי, שפותחה במיוחד להסרת שיער גוף לגברים. מבוססת על שרפי אורן טבעיים ופולימרים מיוחדים שמגבירים את היצמדות השעווה לשיער העבה והגס האופייני לגברים. השעווה מסירה בקלות שיער לא רצוי במריחה אחת, מסייעת להפחית אי־נוחות במהלך ההסרה, ומתאימה לעבודה יעילה באזורים גדולים של הגוף.",
      descriptionAr:
        "شمع للرجال بتركيبة خاصة وبرائحة رجولية، تم تطويره خصيصاً لإزالة شعر الجسم للرجال. يعتمد على راتنجات الصنوبر الطبيعية وبوليمرات مميزة لتعزيز التصاق الشمع بالشعر السميك والخشن الذي يميّز الرجال. يساعد على إزالة الشعر غير المرغوب فيه بسهولة من أول مرة، مع الحفاظ على لطفه على البشرة والمساهمة في تقليل الشعور بالألم قدر الإمكان. تركيبة فعّالة ومناسبة لإزالة الشعر من مناطق الجسم الكبيرة بكفاءة.",
      price: 120.0,
      stock: 80,
      categoryId: catWaxHairRemoval._id,
      brand: "Pier Jouliet",
      sku: "PJ-MEN-BODY-WAX-100G",
      unit: "g",
      netQuantity: 100,
      sizeLabel: "100 g",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Per-100g pricing and formula verified internally.",
        notesAr: "تم توثيق السعر لكل ١٠٠ غرام وتركيبة الشمع داخلياً.",
        notesHe: "המחיר ל-100 גרם והנוסחה מאומתים פנימית.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-MEN-BODY-WAX",
        model: "MEN-BODY-100G",
        productLine: "Wax Products",
      },
      classification: {
        categoryPrimary: "Men's Body Wax",
        categorySecondary: "Wax for Body Hair Removal",
      },
      specs: {
        usageMode: "Heat",
      },
      usage:
        "AR:\nيُسخّن الشمع حتى يصل لقوام مناسب ثم يُختبر على مساحة صغيرة من الجلد.\nيُوضع باتجاه نمو الشعر ويُزال بعكس الاتجاه مع شد الجلد بلطف.\n\nHE:\nיש לחמם את השעווה עד מרקם עבודה מתאים ולבדוק על אזור קטן בעור.\nלמרוח בכיוון צמיחת השיער ולהסיר נגד הכיוון תוך מתיחה עדינה של העור.",
      warnings:
        "AR:\nللاستخدام الخارجي فقط.\nلا يُستخدم على جلد متهيج أو مجروح.\nيُحفظ بعيداً عن متناول الأطفال.\n\nHE:\nלשימוש חיצוני בלבד.\nאין להשתמש על עור מגורה או פצוע.\nיש להרחיק מהישג ידם של ילדים.",
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: [
          "שעווה לגברים",
          "שעווה לגבר",
          "שעווה להסרת שיער",
          "הסרת שיער לגברים",
          "שעווה לגוף",
          "שעווה מקצועית",
          "שרפי אורן",
          "שיער עבה",
          "שיער גס",
          "12 ₪ ל-100 גרם",
          "منتجات إزالة الشعر",
          "شمع للرجال",
          "شمع رجالي",
          "إزالة الشعر للرجال",
          "شمع للجسم",
          "راتنجات الصنوبر",
          "شعر سميك",
          "شعر خشن",
          "12 ₪ لكل 100 غرام",
        ],
        bulletsHe: [
          "נוסחה ייעודית לשיער גוף גברי – עבה וגס.",
          "מבוססת שרפי אורן טבעיים ופולימרים לשיפור ההיצמדות לשיער.",
          "מסירה שיער לא רצוי בקלות במריחה אחת.",
          "עדינה יחסית לעור ומסייעת להפחתת כאב/אי־נוחות.",
          "יעילה במיוחד לאזורי גוף גדולים.",
          "מחיר ל-100 גרם: 12 ₪.",
        ],
        bulletsAr: [
          "تركيبة مخصصة للشعر السميك والخشن لدى الرجال.",
          "يعتمد على راتنجات الصنوبر الطبيعية وبوليمرات لتعزيز الالتصاق بالشعر.",
          "يزيل الشعر غير المرغوب فيه بسهولة من أول تمريرة.",
          "لطيف على البشرة ويساعد على تقليل الانزعاج قدر الإمكان.",
          "مناسب وفعّال للمناطق الكبيرة من الجسم.",
          "السعر لكل 100 غرام: 12 ₪.",
        ],
        shortDescHe: "שעווה לגברים להסרת שיער גוף – אחיזה חזקה לשיער עבה וגס, בניחוח גברי (12 ₪ ל-100 גרם).",
        shortDescAr: "شمع رجالي لإزالة شعر الجسم – التصاق قوي للشعر السميك والخشن وبرائحة رجولية (12 ₪ لكل 100 غرام).",
      },
      tags: [
        "pier-jouliet",
        "men-body-wax",
        "rich-grip",
        "pine-resin",
        "thick-hair",
        "professional-wax",
        "wax-products",
      ],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927129/barber-bang/photo_5814267292580253025_x__2__1771927128822.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927129/barber-bang/photo_5814267292580253025_x__2__1771927128822.jpg",
          altHe: "שעווה להסרת שיער",
          altAr: "شمع لإزالة الشعر",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 24
    {
      titleHe: "שעווה לכל חלקי הגוף",
      titleAr: "شمع لجميع مناطق الجسم",
      descriptionHe:
        "שעווה ייעודית להסרת שיער בכל חלקי הגוף, שפותחה במיוחד לעבודה נוחה ויעילה גם על משטחים גדולים. בזכות הפלסטיות המיוחדת שלה, השעווה נמרחת בקלות בעזרת מרית ויוצרת שכבה דקה וגמישה. השכבה תופסת גם שערות קצרות במיוחד וגם שערות עבות, ומאפשרת הסרה יעילה ללא צורך ברצועות.",
      descriptionAr:
        "شمع مخصص لإزالة الشعر من جميع مناطق الجسم، تم تطويره خصيصاً ليوفر استخداماً سهلاً وفعّالاً حتى على المساحات الكبيرة. بفضل المرونة (اللدونة) الخاصة، يُفرد الشمع بسهولة باستخدام الملعقة/السباتولا ويكوّن طبقة رقيقة ومرنة تلتقط حتى الشعيرات القصيرة جداً والسميكة. يوفّر إزالة فعّالة دون الحاجة إلى شرائط.",
      price: 140.0,
      stock: 70,
      categoryId: catWaxHairRemoval._id,
      brand: "Pier Jouliet",
      sku: "PJ-BODY-WAX-NOSTRIPS-100G",
      unit: "g",
      netQuantity: 100,
      sizeLabel: "100 g",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "No-strips body wax content and pricing verified internally.",
        notesAr: "تم توثيق محتوى شمع الجسم بدون شرائط والسعر داخلياً.",
        notesHe: "תוכן ומחיר שעוות גוף ללא רצועות אומתו פנימית.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-BODY-WAX-NOSTRIPS",
        model: "BODY-ALL-100G",
        productLine: "Wax Products",
      },
      classification: {
        categoryPrimary: "All Body Wax",
        categorySecondary: "No Strips Wax",
      },
      specs: {
        usageMode: "Heat",
      },
      usage:
        "AR:\nيُسخّن الشمع حتى قوام مناسب ثم يُفرد بطبقة رقيقة بالسباتولا.\nتُزال الطبقة بعد التماسك بعكس اتجاه نمو الشعر بدون شرائط.\n\nHE:\nיש לחמם את השעווה למרקם עבודה מתאים ולמרוח שכבה דקה בעזרת מרית.\nלאחר התייצבות יש להסיר נגד כיוון צמיחת השיער ללא רצועות.",
      warnings:
        "AR:\nللاستخدام الخارجي فقط.\nلا يُستخدم على جلد متهيج أو مجروح.\nيُحفظ بعيداً عن متناول الأطفال.\n\nHE:\nלשימוש חיצוני בלבד.\nאין להשתמש על עור מגורה או פצוע.\nיש להרחיק מהישג ידם של ילדים.",
      packageIncludes: [],
      packageIncludesAr: [],
      packageIncludesHe: [],
      publishContent: {
        seoKeywords: [
          "שעווה לכל הגוף",
          "שעווה להסרת שיער",
          "הסרת שיער",
          "שעווה ללא רצועות",
          "שעווה מקצועית",
          "שעווה עם מרית",
          "שערות קצרות",
          "שערות עבות",
          "מוצרי שעווה",
          "טיפוח הגוף",
          "14 ₪ ל-100 גרם",
          "شمع للجسم",
          "شمع إزالة الشعر",
          "إزالة الشعر",
          "شمع بدون شرائط",
          "شمع احترافي",
          "سباتولا",
          "شعر قصير",
          "شعر سميك",
          "منتجات الشمع",
          "عناية الجسم",
          "14 ₪ لكل 100 غرام",
        ],
        bulletsHe: [
          "מתאימה להסרת שיער בכל חלקי הגוף.",
          "פלסטיות גבוהה למריחה קלה בעזרת מרית על אזורים גדולים.",
          "יוצרת שכבה דקה וגמישה לאחיזה טובה בשיער.",
          "תופסת גם שערות קצרות וגם עבות במיוחד.",
          "הסרה ללא צורך ברצועות (No Strips).",
          "מחיר ל-100 גרם: 14 ₪.",
        ],
        bulletsAr: [
          "مناسب لإزالة الشعر من جميع مناطق الجسم.",
          "مرونة عالية لتوزيع سهل بالسباتولا على المناطق الكبيرة.",
          "يشكّل طبقة رقيقة ومرنة لالتقاط أفضل للشعر.",
          "يلتقط حتى الشعيرات القصيرة جداً والسميكة.",
          "إزالة بدون الحاجة إلى شرائط (No Strips).",
          "السعر لكل 100 غرام: 14 ₪.",
        ],
        shortDescHe: "שעווה לכל הגוף – נמרחת בקלות, שכבה דקה וגמישה, הסרה ללא רצועות (14 ₪ ל-100 גרם).",
        shortDescAr: "شمع لجميع مناطق الجسم – فرد سهل، طبقة رقيقة مرنة، إزالة بدون شرائط (14 ₪ لكل 100 غرام).",
      },
      tags: [
        "pier-jouliet",
        "all-body-wax",
        "no-strips",
        "spatula-application",
        "short-hair-grip",
        "thick-hair-grip",
        "wax-products",
      ],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927199/barber-bang/photo_5814267292580253007_x__2__1771927199286.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927199/barber-bang/photo_5814267292580253007_x__2__1771927199286.jpg",
          altHe: "שעווה לכל חלקי הגוף",
          altAr: "شمع لجميع مناطق الجسم",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 25
    {
      titleHe: "מי קולון – אפטר שייב",
      titleAr: "كولونيا – أفتر شيف (بعد الحلاقة)",
      descriptionHe:
        "מי קולון אפטר שייב מרעננים הזמינים ב־3 ניחוחות מוכרים ושונים. מעניקים תחושת רעננות אחרי גילוח, מסייעים להרגיע את העור ומשאירים אותו רענן לאורך זמן. מומלץ לשימוש לאחר גילוח כחלק משגרת טיפוח יומיומית למראה נקי ומטופח.",
      descriptionAr:
        "كولونيا أفتر شيف منعشة متوفرة بثلاث روائح مختلفة ومعروفة. تمنح إحساساً بالانتعاش بعد الحلاقة، تساعد على تهدئة البشرة، وتترك الجلد منتعشاً لفترة طويلة. يُنصح باستخدامها بعد الحلاقة كجزء من روتين عناية يومي لمظهر نظيف ومعتنى به.",
      price: 60.0,
      stock: 100,
      categoryId: catAfterShave._id,
      brand: "Pier Jouliet",
      sku: "PJ-AFTER-SHAVE-COLOGNE-3SCENTS",
      unit: "ml",
      netQuantity: null,
      sizeLabel: "3 scents",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Unit price kept as provided: 24 ILS / 100ml (implies ~250ml, actual volume not specified).",
        notesAr: "تم الإبقاء على سعر الوحدة كما ورد: 24 شيكل لكل 100 مل (يوحي بحجم يقارب 250 مل، بينما الحجم الفعلي غير مذكور).",
        notesHe: "מחיר היחידה נשמר כפי שסופק: 24₪ ל-100 מ״ל (מרמז על כ-250 מ״ל, אך הנפח בפועל לא צוין).",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-AFTER-SHAVE-COLOGNE-3SCENTS",
        model: "AFTER-SHAVE-3SCENTS",
        productLine: "After Shave",
      },
      classification: {
        categoryPrimary: "After Shave Cologne",
        categorySecondary: "Men Grooming",
      },
      specs: {
        scentVariants: 3,
      },
      packageIncludes: ["After shave cologne bottle (3 scent variants)"],
      packageIncludesAr: ["كولونيا أفتر شيف (3 روائح مختلفة)"],
      packageIncludesHe: ["מי קולון אפטר שייב (3 ניחוחות שונים)"],
      publishContent: {
        seoKeywords: [
          "אפטר שייב",
          "מי קולון",
          "אפטר שייב לגבר",
          "בושם אחרי גילוח",
          "טיפוח לגבר",
          "מוצרי גילוח",
          "רענון אחרי גילוח",
          "ניחוח לגבר",
          "After Shave",
          "أفتر شيف",
          "بعد الحلاقة",
          "كولونيا بعد الحلاقة",
          "عناية الرجال",
          "منتجات الحلاقة",
          "تهدئة البشرة",
          "انتعاش",
          "روائح رجالية",
          "After Shave",
          "24 ₪ / 100ml",
        ],
        bulletsHe: [
          "אפטר שייב מרענן לאחר גילוח.",
          "זמין ב־3 ניחוחות מוכרים ושונים.",
          "מסייע לתחושת רוגע ורעננות בעור.",
          "משאיר את העור רענן לאורך זמן.",
          "מומלץ לשימוש כחלק משגרת גילוח וטיפוח.",
          "מחיר ל־100 מ״ל: 24₪ (כפי שסופק; נפח בפועל לא צוין).",
        ],
        bulletsAr: [
          "أفتر شيف منعش للاستخدام بعد الحلاقة.",
          "متوفر بـ 3 روائح مختلفة ومعروفة.",
          "يساعد على تهدئة البشرة بعد الحلاقة.",
          "يترك البشرة منتعشة لفترة طويلة.",
          "مناسب كجزء من روتين الحلاقة والعناية اليومي.",
          "السعر لكل 100 مل: 24₪ (كما ورد؛ الحجم الفعلي غير مذكور).",
        ],
        shortDescHe: "אפטר שייב מרענן ב־3 ניחוחות – לשימוש אחרי גילוח, רעננות לאורך זמן.",
        shortDescAr: "أفتر شيف منعش بثلاث روائح – للاستخدام بعد الحلاقة وانتعاش يدوم.",
      },
      tags: [
        "pier-jouliet",
        "after-shave",
        "cologne",
        "3-scents",
        "men-grooming",
        "post-shave",
      ],
      images: [
        {
          url: "/uploads/seed/products/11_PierJouliet_AfterShave.jpeg",
          secureUrl: "/uploads/seed/products/11_PierJouliet_AfterShave.jpeg",
          altHe: "מי קולון אפטר שייב",
          altAr: "كولونيا أفتر شيف",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 26
    {
      titleHe: "ספריי חיטוי למכונות תספורת – 4 הפעולות",
      titleAr: "سبراي تعقيم لماكينات الحلاقة – 4 وظائف",
      descriptionHe:
        "ספריי תחזוקה וחיטוי למכונות תספורת וגילוח – “4 הפעולות”, מיועד לשימוש בלהבים של מכונות תספורת וגילוח ובמסרקי שיער. הספריי מספק טיפול כולל: שימון לשמירה על הלהבים והמנוע ומניעת שחיקה וחלודה, ניקוי בלחץ להסרת שערות ושאריות מהלהב, חיטוי מלא הודות לתכולת אלכוהול, וקירור הלהב במקרה של התחממות כתוצאה מעומס. פתרון יעיל לשמירה על ביצועי המכונה, היגיינה ואריכות חיי הלהבים.",
      descriptionAr:
        "سبراي صيانة وتعقيم لماكينات قص الشعر والحلاقة – “4 وظائف”، مخصص للاستخدام على شفرات ماكينات القص والحلاقة وعلى أمشاط الشعر. يوفر عناية شاملة: تشحيم للحفاظ على الشفرات والمحرك وتقليل التآكل ومنع الصدأ، تنظيف بضغط الرذاذ لإزالة الشعر وبقايا القص من الشفرة، تعقيم كامل لاحتوائه على الكحول، وتبريد للشفرة عند سخونتها بسبب الضغط أو الاستخدام المكثف. حل عملي للحفاظ على أداء الماكينة ونظافتها وإطالة عمر الشفرات.",
      price: 60.0,
      stock: 120,
      categoryId: catMachineMaintenance._id,
      brand: "Barber Care",
      sku: "PJ-CLIPPER-BLADE-SPRAY-4IN1",
      unit: "ml",
      netQuantity: null,
      sizeLabel: null,
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Unit price kept as provided: 15 ILS / 100ml (total volume not specified).",
        notesAr: "تم الإبقاء على سعر الوحدة كما ورد: 15 شيكل لكل 100 مل (الحجم الكلي غير مذكور).",
        notesHe: "מחיר היחידה נשמר כפי שסופק: 15₪ ל-100 מ״ל (הנפח הכולל לא צוין).",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PJ-CLIPPER-BLADE-SPRAY-4IN1",
        model: "BLADE-SPRAY-4IN1",
        productLine: "Barber Accessories",
      },
      classification: {
        categoryPrimary: "Clipper Blade Maintenance Spray",
        categorySecondary: "4-in-1",
      },
      specs: {
        usageMode: "Spray",
      },
      packageIncludes: ["4-in-1 maintenance spray for clipper blades"],
      packageIncludesAr: ["سبراي 4-في-1 لصيانة شفرات الماكينات"],
      packageIncludesHe: ["ספריי 4-ב-1 לתחזוקת להבים"],
      publishContent: {
        seoKeywords: [
          "ספריי חיטוי למכונת תספורת",
          "ספריי ללהבים",
          "תחזוקת מכונת תספורת",
          "ניקוי להבים",
          "חיטוי להבים",
          "שימון להבים",
          "קירור להבים",
          "4 פעולות",
          "מוצרי מספרה",
          "מכונת גילוח",
          "سبراي تعقيم",
          "سبراي للشفرات",
          "صيانة ماكينة حلاقة",
          "تنظيف الشفرات",
          "تعقيم الشفرات",
          "تشحيم الشفرات",
          "تبريد الشفرات",
          "4 وظائف",
          "مستلزمات صالون",
          "ماكينة قص الشعر",
          "15 ₪ / 100ml",
        ],
        bulletsHe: [
          "מיועד ללהבי מכונות תספורת וגילוח ולמסרקי שיער.",
          "שימון: מפחית שחיקה, שומר על הלהבים והמנוע ומונע חלודה.",
          "ניקוי בלחץ: מנקה שערות ושאריות מהלהב בהתזה.",
          "חיטוי: מכיל אלכוהול לחיטוי מלא.",
          "קירור: מקרר את הלהב בזמן התחממות עקב עומס.",
        ],
        bulletsAr: [
          "مخصص لشفرات ماكينات قص الشعر والحلاقة ولأمشاط الشعر.",
          "تشحيم: يقلل التآكل ويحافظ على الشفرة والمحرك ويمنع الصدأ.",
          "تنظيف بضغط الرذاذ: يزيل الشعر والبقايا من الشفرة.",
          "تعقيم: يحتوي على كحول لتعقيم كامل.",
          "تبريد: يبرد الشفرة عند ارتفاع الحرارة بسبب الاستخدام المكثف.",
        ],
        shortDescHe: "ספריי 4-ב-1 ללהבים: שימון, ניקוי, חיטוי וקירור – למכונות תספורת וגילוח.",
        shortDescAr: "سبراي 4-في-1 للشفرات: تشحيم، تنظيف، تعقيم وتبريد – لماكينات الحلاقة وقص الشعر.",
      },
      tags: ["clipper-spray", "blade-maintenance", "4-in-1", "barber-accessories", "disinfection", "cooling"],
      images: [{ url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927324/barber-bang/photo_5814267292580253010_x_1771927324336.jpg", secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927324/barber-bang/photo_5814267292580253010_x_1771927324336.jpg", altHe: "ספריי חיטוי למכונות תספורת", altAr: "سبراي تعقيم لماكينات الحلاقة", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 27
    {
      titleHe: "Pumas Blizzard מפוח (קומפרסור)",
      titleAr: "منفاخ Pumas Blizzard (كمبروسر)",
      descriptionHe:
        "מפוח קומפרסור PUMAS Blizzard הוא הפתרון המושלם לניקוי מהיר, יעיל ונוח בעמדת העבודה. המפוח מספק זרימת אוויר חזקה במיוחד עם פיה מדויקת, המאפשרת הסרה יסודית של שיער, אבק ושאריות פסולת בלחיצה אחת. הוא מגיע בעיצוב קומפקטי וארגונומי שמבטיח אחיזה נוחה ושימוש ממושך ללא מאמץ. עם מנוע עוצמתי ויציב, ה-Blizzard מספק ביצועים עקביים וזרימת אוויר חזקה בכל שימוש, לשמירה על סביבת עבודה נקייה, היגיינית ומקצועית.",
      descriptionAr:
        "منفاخ/كمبروسر PUMAS Blizzard هو الحل المثالي لتنظيف محطة العمل بسرعة وكفاءة وبشكل مريح. يوفر تدفق هواء قوي جداً مع فوهة دقيقة تتيح إزالة الشعر والغبار وبقايا القص بضغطة واحدة. يأتي بتصميم مدمج ومريح (أرجونومي) يمنح قبضة سهلة ويسمح بالاستخدام لفترات طويلة دون تعب. بفضل محرك قوي وثابت، يقدم Blizzard أداءً ثابتاً وتدفق هواء قوياً في كل استخدام، للحفاظ على بيئة عمل نظيفة وصحية واحترافية.",
      price: 300.0,
      stock: 25,
      categoryId: catHairDryersBlowers._id,
      brand: "PUMAS",
      sku: "PUMAS-BLIZZARD-COMPRESSOR",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Catalog-ready copy provided for workstation cleaning compressor.",
        notesAr: "تم اعتماد وصف جاهز للنشر لمنفاخ/كمبروسر تنظيف محطة العمل.",
        notesHe: "אושר תוכן קטלוג מוכן לפרסום עבור מפוח/קומפרסור לניקוי עמדת עבודה.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PUMAS-BLIZZARD-COMPRESSOR",
        model: "BLIZZARD",
        productLine: "Barber Workstation Accessories",
      },
      classification: {
        categoryPrimary: "Workstation Cleaning Blower / Compressor",
        categorySecondary: "Barber Accessories",
      },
      specs: {
        usageMode: "Corded",
      },
      packageIncludes: ["PUMAS Blizzard compressor blower unit"],
      packageIncludesAr: ["وحدة منفاخ/كمبروسر PUMAS Blizzard"],
      packageIncludesHe: ["יחידת מפוח/קומפרסור PUMAS Blizzard"],
      publishContent: {
        seoKeywords: [
          "מפוח למספרה",
          "קומפרסור למספרה",
          "PUMAS Blizzard",
          "מפוח ניקוי",
          "ניקוי עמדת עבודה",
          "אביזרי מספרה",
          "זרימת אוויר חזקה",
          "פיה מדויקת",
          "ציוד ספרים",
          "היגיינה במספרה",
          "منفاخ صالون",
          "كمبروسر صالون",
          "PUMAS Blizzard",
          "منفاخ تنظيف",
          "تنظيف محطة العمل",
          "مستلزمات الصالون",
          "هواء قوي",
          "فوهة دقيقة",
          "معدات الحلاقة",
          "نظافة الصالون",
        ],
        bulletsHe: [
          "זרימת אוויר חזקה במיוחד לניקוי מהיר.",
          "פיה מדויקת להסרה יסודית של שיער, אבק ושאריות פסולת.",
          "עיצוב קומפקטי וארגונומי לאחיזה נוחה.",
          "מתאים לשימוש ממושך ללא מאמץ.",
          "מנוע עוצמתי ויציב לביצועים עקביים בכל שימוש.",
        ],
        bulletsAr: [
          "تدفق هواء قوي جداً لتنظيف سريع.",
          "فوهة دقيقة لإزالة الشعر والغبار وبقايا القص بفعالية.",
          "تصميم مدمج ومريح لسهولة الإمساك.",
          "مناسب للاستخدام الطويل دون إجهاد.",
          "محرك قوي وثابت لأداء متناسق في كل مرة.",
        ],
        shortDescHe: "מפוח קומפרסור PUMAS Blizzard – זרימת אוויר חזקה לניקוי מהיר של עמדת העבודה.",
        shortDescAr: "منفاخ/كمبروسر PUMAS Blizzard – هواء قوي لتنظيف سريع واحترافي لمحطة العمل.",
      },
      tags: ["pumas", "blizzard", "compressor", "blower", "barber-accessories", "workstation-cleaning"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926448/barber-bang/photo_5814267292580253009_x_1771926447797.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926448/barber-bang/photo_5814267292580253009_x_1771926447797.jpg",
          altHe: "PUMAS Blizzard מפוח קומפרסור",
          altAr: "منفاخ PUMAS Blizzard",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 28
    {
      titleHe: "מייבש שיער Pumas Cyclone",
      titleAr: "مجفف شعر Pumas Cyclone",
      descriptionHe:
        "מייבש שיער מקצועי וחזק Pumas Cyclone עם מנוע BLDC עוצמתי במיוחד במהירות 21,000 סל״ד (rpm), המספק זרימת אוויר חזקה במיוחד לייבוש מהיר ויעיל. מנוע בעל חיי עבודה ארוכים—עד פי 3 ממנוע רגיל ועד 3,000 שעות—לביצועים עקביים לאורך זמן. הפן שקט יחסית, קל משקל (עד 44% פחות מפן רגיל) ובעל ידית ארגונומית לאחיזה נוחה. כולל 2 פיות לריכוז החום לעיצוב מדויק, וכבל גמיש באורך 3 מטר לנוחות תנועה בעמדת העבודה.",
      descriptionAr:
        "مجفف شعر احترافي وقوي Pumas Cyclone مزوّد بمحرك BLDC عالي الأداء بسرعة 21,000 دورة/دقيقة (rpm)، يمنح تدفق هواء قوي جداً لتجفيف أسرع وأكثر كفاءة. يتميز بعمر محرك طويل يصل إلى 3 أضعاف المحركات التقليدية وحتى 3,000 ساعة تشغيل، ما يوفر أداءً ثابتاً على المدى الطويل. يعمل بهدوء نسبي مع وزن أخف حتى 44% مقارنة بمجفف عادي، ويأتي بمقبض مريح (أرجونومي) لثبات أفضل أثناء الاستخدام. يتضمن فوهتين لتركيز الحرارة لتصفيف أدق، مع سلك مرن بطول 3 أمتار لحرية حركة ممتازة في محطة العمل.",
      price: 500.0,
      stock: 20,
      categoryId: catHairDryersBlowers._id,
      brand: "PUMAS",
      sku: "PUMAS-CYCLONE-BLDC-21000",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Mapped to existing hair devices category in current catalog structure.",
        notesAr: "تم ربطه بفئة الأجهزة المتاحة حالياً ضمن هيكل الكتالوج.",
        notesHe: "המוצר מופנה לקטגוריית המכשירים הקיימת במבנה הקטלוג הנוכחי.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PUMAS-CYCLONE-BLDC-21000",
        model: "Cyclone",
        productLine: "Pumas Professional Hair Devices",
      },
      classification: {
        categoryPrimary: "Professional Hair Dryer",
        categorySecondary: "BLDC Motor",
      },
      specs: {
        motorType: "BLDC",
        motorSpeedRpmMin: 21000,
        motorSpeedRpmMax: 21000,
        runtimeHoursRated: 3000,
        cableLengthM: 3,
        nozzleCount: 2,
        usageMode: "Corded",
      },
      packageIncludes: ["Pumas Cyclone hair dryer", "2 concentrator nozzles"],
      packageIncludesAr: ["مجفف شعر Pumas Cyclone", "فوهتان لتركيز الحرارة"],
      packageIncludesHe: ["מייבש שיער Pumas Cyclone", "2 פיות לריכוז חום"],
      publishContent: {
        seoKeywords: [
          "פן מקצועי",
          "מייבש שיער",
          "Pumas Cyclone",
          "מנוע BLDC",
          "21000rpm",
          "פן שקט",
          "זרימת אוויר חזקה",
          "פיות לריכוז חום",
          "כבל 3 מטר",
          "מכשירי שיער מקצועיים",
          "مجفف شعر",
          "سشوار",
          "Pumas Cyclone",
          "محرك BLDC",
          "21000rpm",
          "مجفف احترافي",
          "مجفف هادئ",
          "تدفق هواء قوي",
          "فوهة تركيز",
          "سلك 3 متر",
          "أجهزة شعر",
        ],
        bulletsHe: [
          "מנוע BLDC מקצועי ועוצמתי במיוחד – 21,000rpm.",
          "חיי מנוע ארוכים: עד פי 3 ממנוע רגיל ועד 3,000 שעות.",
          "מנוע שקט וזרימת אוויר חזקה במיוחד לייבוש מהיר.",
          "כולל 2 פיות לריכוז החום לעיצוב מדויק.",
          "קל משקל עד 44% פחות מפן רגיל + ידית ארגונומית.",
          "כבל גמיש באורך 3 מטר לנוחות עבודה.",
        ],
        bulletsAr: [
          "محرك BLDC احترافي قوي جداً بسرعة 21,000rpm.",
          "عمر محرك طويل: حتى 3 أضعاف المحركات العادية وحتى 3,000 ساعة.",
          "تشغيل هادئ نسبياً وتدفق هواء قوي لتجفيف سريع.",
          "فوهتان لتركيز الحرارة لتصفيف أدق.",
          "وزن أخف حتى 44% + مقبض مريح لسهولة الإمساك.",
          "سلك مرن بطول 3 أمتار لراحة أكبر أثناء العمل.",
        ],
        shortDescHe: "פן מקצועי Pumas Cyclone עם מנוע BLDC 21,000rpm – קל, שקט, זרימת אוויר חזקה וכבל 3 מ׳.",
        shortDescAr: "مجفف Pumas Cyclone بمحرك BLDC بسرعة 21,000rpm – خفيف، هادئ، هواء قوي وسلك 3 م.",
      },
      tags: ["pumas", "cyclone", "hair-dryer", "bldc", "21000rpm", "professional-hair-device"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926513/barber-bang/photo_5814267292580253014_x_1771926512921.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926513/barber-bang/photo_5814267292580253014_x_1771926512921.jpg",
          altHe: "מייבש שיער Pumas Cyclone",
          altAr: "مجفف شعر Pumas Cyclone",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 28-A
    {
      titleHe: "מייבש שיער קטן לנסיעות (מיני)",
      titleAr: "مجفف شعر صغير للسفر (ميني)",
      descriptionHe:
        "מייבש שיער מיני לנסיעות – קומפקטי וקל משקל, אידיאלי לתיק נסיעות ולשימוש יומיומי מחוץ לבית. כולל שתי מהירויות ושני מצבי חום להתאמה מהירה לסוג השיער ולתוצאה הרצויה. הספק 1100W לייבוש יעיל בגודל קטן, ומגיע עם פיה לריכוז האוויר ודיפיוזר לפיזור עדין ולעיצוב טבעי.",
      descriptionAr:
        "مجفف شعر ميني للسفر بحجم صغير ووزن خفيف، مثالي للحقيبة وللاستخدام خارج المنزل. يأتي بسرعتين تشغيل وبوضعين للحرارة لتعديل الأداء حسب نوع الشعر والنتيجة المطلوبة. بقدرة 1100W لتجفيف فعّال ضمن حجم مدمج، ويتضمن فوهة لتركيز الهواء وديفيوزر لتوزيع الهواء بلطف ولمظهر تصفيف طبيعي.",
      price: 100.0,
      stock: 45,
      categoryId: catHairDryersBlowers._id,
      brand: "PUMAS",
      sku: "PUMAS-MINI-TRAVEL-DRYER-1100W",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Travel mini dryer content approved for catalog publishing.",
        notesAr: "تم اعتماد وصف مجفف السفر الميني للنشر في الكتالوج.",
        notesHe: "תוכן מייבש המיני לנסיעות אושר לפרסום בקטלוג.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PUMAS-MINI-TRAVEL-DRYER-1100W",
        model: "MINI-TRAVEL-1100W",
        productLine: "Pumas Travel Hair Devices",
      },
      classification: {
        categoryPrimary: "Mini Travel Hair Dryer",
        categorySecondary: "Hair Dryer",
      },
      specs: {
        powerW: 1100,
        speedModes: 2,
        heatModes: 2,
        nozzleCount: 1,
        diffuserIncluded: true,
        usageMode: "Corded",
      },
      packageIncludes: ["Mini travel hair dryer", "Concentrator nozzle", "Diffuser"],
      packageIncludesAr: ["مجفف شعر ميني للسفر", "فوهة تركيز", "ديفيوزر"],
      packageIncludesHe: ["מייבש שיער מיני לנסיעות", "פיה לריכוז", "דיפיוזר"],
      publishContent: {
        seoKeywords: [
          "מייבש שיער לנסיעות",
          "פן קטן",
          "מייבש מיני",
          "מייבש 1100W",
          "פן מיני",
          "דיפיוזר",
          "פיה לריכוז",
          "מייבש קומפקטי",
          "מכשירי שיער",
          "מייבש קל משקל",
          "مجفف شعر للسفر",
          "مجفف ميني",
          "سشوار صغير",
          "1100W",
          "مجفف خفيف",
          "ديفيوزر",
          "فوهة تركيز",
          "أجهزة الشعر",
          "مجفف مدمج",
          "عناية الشعر",
        ],
        bulletsHe: [
          "מייבש שיער מיני קומפקטי לנסיעות.",
          "קל משקל ונוח לנשיאה.",
          "2 מהירויות עבודה.",
          "2 מצבי חום להתאמה לשיער.",
          "הספק 1100W.",
          "כולל פיה לריכוז ודיפיוזר.",
        ],
        bulletsAr: [
          "مجفف شعر ميني مناسب للسفر.",
          "خفيف الوزن وسهل الحمل.",
          "سرعتان للتشغيل.",
          "وضعان للحرارة حسب الحاجة.",
          "قدرة 1100W.",
          "يتضمن فوهة تركيز + ديفيوزر.",
        ],
        shortDescHe: "מייבש שיער מיני לנסיעות 1100W – קל, 2 מהירויות, 2 מצבי חום, כולל פיה ודיפיוזר.",
        shortDescAr: "مجفف شعر ميني للسفر 1100W – خفيف، سرعتان، وضعا حرارة، مع فوهة وديفيوزر.",
      },
      tags: ["pumas", "mini-dryer", "travel-hair-dryer", "1100w", "diffuser", "compact"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926376/barber-bang/photo_5814267292580253016_x_1771926375964.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926376/barber-bang/photo_5814267292580253016_x_1771926375964.jpg",
          altHe: "מייבש שיער מיני לנסיעות",
          altAr: "مجفف شعر ميني للسفر",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 28-B
    {
      titleHe: "מייבש שיער (פן) טיפוני Tifone – Pumas",
      titleAr: "مجفف شعر (سشوار) تيفوني Tifone – Pumas",
      descriptionHe:
        "מייבש שיער (פן) טיפוני Tifone מהסדרה המקצועית של פומאס. מבנה ארגונומי קטן ונוח לאחיזה, עם מנוע חזק בעוצמת 2500W המספק זרימת אוויר חמה במיוחד לייבוש מהיר ולתוצאות מקצועיות. כולל כפתור אוויר קר מיידי (Cool Shot) לקיבוע העיצוב ולנוחות בזמן עבודה. מיוצר באיטליה ומתאים לשימוש מקצועי בעמדת עבודה או למי שמחפש פן עוצמתי ואמין בבית.",
      descriptionAr:
        "مجفف شعر (سشوار) تيفوني Tifone من السلسلة الاحترافية من Pumas. يتميز بتصميم صغير ومريح (أرجونومي) مع محرك قوي بقدرة 2500W يوفر هواءً ساخناً جداً لتجفيف سريع ونتائج احترافية. يحتوي على زر هواء بارد فوري (Cool Shot) لتثبيت التسريحة وتحكم أفضل أثناء الاستخدام. صناعة إيطالية، مناسب للاستخدام المهني في الصالون أو لمن يريد مجففاً قوياً وموثوقاً في المنزل.",
      price: 580.0,
      stock: 18,
      categoryId: catHairDryersBlowers._id,
      brand: "PUMAS",
      sku: "PUMAS-TIFONE-2500W",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Professional dryer mapped to existing hair devices category in current catalog structure.",
        notesAr: "تم ربط المجفف الاحترافي بفئة الأجهزة المتاحة حالياً في بنية الكتالوج.",
        notesHe: "המייבש המקצועי מופנה לקטגוריית המכשירים הקיימת במבנה הקטלוג הנוכחי.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PUMAS-TIFONE-2500W",
        model: "Tifone",
        productLine: "Pumas Professional Hair Devices",
      },
      classification: {
        categoryPrimary: "Professional Hair Dryer",
        categorySecondary: "2500W",
      },
      specs: {
        powerW: 2500,
        coolShot: true,
        usageMode: "Corded",
        originCountry: "Italy",
      },
      packageIncludes: ["Pumas Tifone hair dryer"],
      packageIncludesAr: ["مجفف شعر Pumas Tifone"],
      packageIncludesHe: ["מייבש שיער Pumas Tifone"],
      publishContent: {
        seoKeywords: [
          "פן מקצועי",
          "מייבש שיער",
          "Pumas Tifone",
          "טיפוני",
          "2500W",
          "פן איטלקי",
          "מיוצר באיטליה",
          "כפתור אוויר קר",
          "Cool Shot",
          "מייבש שיער מקצועי",
          "مجفف شعر",
          "سشوار",
          "Pumas Tifone",
          "تيفوني",
          "2500W",
          "مجفف احترافي",
          "زر هواء بارد",
          "Cool Shot",
          "صناعة إيطالية",
          "أجهزة الشعر",
        ],
        bulletsHe: [
          "פן מקצועי מסדרת Pumas.",
          "מנוע עוצמתי 2500W לאוויר חם במיוחד.",
          "מבנה קומפקטי וארגונומי לאחיזה נוחה.",
          "כפתור אוויר קר מיידי (Cool Shot) לקיבוע עיצוב.",
          "מיוצר באיטליה.",
        ],
        bulletsAr: [
          "مجفف احترافي من سلسلة Pumas.",
          "قدرة 2500W لهواء ساخن قوي جداً وتجفيف سريع.",
          "تصميم صغير ومريح لسهولة الإمساك.",
          "زر هواء بارد فوري (Cool Shot) لتثبيت التسريحة.",
          "صناعة إيطالية.",
        ],
        shortDescHe: "פן מקצועי Pumas Tifone 2500W – קומפקטי, ארגונומי, כפתור אוויר קר מיידי, מיוצר באיטליה.",
        shortDescAr: "مجفف Pumas Tifone الاحترافي 2500W – تصميم مدمج، زر هواء بارد فوري، صناعة إيطالية.",
      },
      tags: ["pumas", "tifone", "hair-dryer", "2500w", "cool-shot", "made-in-italy"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926586/barber-bang/photo_5814267292580253013_x_1771926586336.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926586/barber-bang/photo_5814267292580253013_x_1771926586336.jpg",
          altHe: "פן Pumas Tifone",
          altAr: "مجفف Pumas Tifone",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 28-C
    {
      titleHe: "מייבש שיער (פן) טורנאדו Pumas Tornado",
      titleAr: "مجفف شعر (سشوار) تورنادو Pumas Tornado",
      descriptionHe:
        "מייבש שיער (פן) טורנאדו Pumas Tornado מקצועי מבית פומאס. כולל מנוע חזק בעוצמת 2500W המספק זרימת אוויר עוצמתית לייבוש מהיר ותוצאות מקצועיות. מצויד בכפתור אוויר קר מיידי (Cool Shot) לקיבוע העיצוב ולשליטה טובה יותר בזמן העבודה. מיוצר באיטליה ומתאים במיוחד לשימוש מקצועי במספרה או לכל מי שמחפש פן עוצמתי ואמין בבית.",
      descriptionAr:
        "مجفف شعر (سشوار) تورنادو Pumas Tornado الاحترافي من Pumas. مزوّد بمحرك قوي بقدرة 2500W يوفر تدفق هواء قوي لتجفيف سريع ونتائج احترافية. يحتوي على زر هواء بارد فوري (Cool Shot) لتثبيت التسريحة وتحكم أفضل أثناء الاستخدام. صناعة إيطالية، مناسب للصالونات والاستخدام المنزلي لمن يبحث عن أداء قوي وموثوق.",
      price: 500.0,
      stock: 20,
      categoryId: catHairDryersBlowers._id,
      brand: "PUMAS",
      sku: "PUMAS-TORNADO-2500W",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Professional dryer mapped to existing hair devices category in current catalog structure.",
        notesAr: "تم ربط المجفف الاحترافي بفئة الأجهزة المتاحة حالياً في بنية الكتالوج.",
        notesHe: "המייבש המקצועי מופנה לקטגוריית המכשירים הקיימת במבנה הקטלוג הנוכחי.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PUMAS-TORNADO-2500W",
        model: "Tornado",
        productLine: "Pumas Professional Hair Devices",
      },
      classification: {
        categoryPrimary: "Professional Hair Dryer",
        categorySecondary: "2500W",
      },
      specs: {
        powerW: 2500,
        coolShot: true,
        usageMode: "Corded",
        originCountry: "Italy",
      },
      packageIncludes: ["Pumas Tornado hair dryer"],
      packageIncludesAr: ["مجفف شعر Pumas Tornado"],
      packageIncludesHe: ["מייבש שיער Pumas Tornado"],
      publishContent: {
        seoKeywords: [
          "פן מקצועי",
          "מייבש שיער",
          "Pumas Tornado",
          "טורנאדו",
          "2500W",
          "פן איטלקי",
          "מיוצר באיטליה",
          "כפתור אוויר קר",
          "Cool Shot",
          "מייבש שיער מקצועי",
          "مجفف شعر",
          "سشوار",
          "Pumas Tornado",
          "تورنادو",
          "2500W",
          "مجفف احترافي",
          "زر هواء بارد",
          "Cool Shot",
          "صناعة إيطالية",
          "أجهزة الشعر",
        ],
        bulletsHe: [
          "פן מקצועי מבית Pumas.",
          "מנוע עוצמתי 2500W לייבוש מהיר.",
          "כפתור אוויר קר מיידי (Cool Shot) לקיבוע עיצוב.",
          "מיוצר באיטליה.",
          "מתאים לשימוש מקצועי ולשימוש ביתי מתקדם.",
        ],
        bulletsAr: [
          "مجفف احترافي من Pumas.",
          "قدرة 2500W لتجفيف سريع وأداء قوي.",
          "زر هواء بارد فوري (Cool Shot) لتثبيت التسريحة.",
          "صناعة إيطالية.",
          "مناسب للاستخدام المهني والمنزلي المتقدم.",
        ],
        shortDescHe: "פן מקצועי Pumas Tornado 2500W – כפתור אוויר קר מיידי, מיוצר באיטליה.",
        shortDescAr: "مجفف Pumas Tornado الاحترافي 2500W – زر هواء بارد فوري، صناعة إيطالية.",
      },
      tags: ["pumas", "tornado", "hair-dryer", "2500w", "cool-shot", "made-in-italy"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926618/barber-bang/photo_5814267292580253012_x_1771926618432.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926618/barber-bang/photo_5814267292580253012_x_1771926618432.jpg",
          altHe: "פן Pumas Tornado",
          altAr: "مجفف Pumas Tornado",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 28-D
    {
      titleHe: "מברשת שיער חשמלית",
      titleAr: "فرشاة شعر كهربائية",
      descriptionHe:
        "מברשת שיער חשמלית מקצועית המסייעת בייבוש ועיצוב מהירים יותר—וכך מפחיתה חשיפה ממושכת לחום ותורמת לצמצום נזק לשיער. המברשת תומכת בייבוש מהיר, מפחיתה קרזול וחשמל סטטי ומסייעת להשגת מראה רך ומבריק יותר. משטח קרמי איכותי מפזר את החום באופן אחיד על פני המברשת, בעוד יונים שליליים “עוטפים” את השערה ומסייעים להפחתת סטטיות ופריז, לקבלת תוצאה חלקה ומסודרת.",
      descriptionAr:
        "فرشاة شعر كهربائية احترافية تساعد على تجفيف وتصفيف الشعر بسرعة أكبر، ما يقلل مدة التعرض للحرارة ويساهم في تقليل ضرر الشعر. تدعم التجفيف السريع وتساعد على تقليل الهيشان والكهرباء الساكنة، لتمنح الشعر ملمساً أنعم ولمعاناً أفضل. تتميز بسطح سيراميك عالي الجودة يوزّع الحرارة بشكل متساوٍ على كامل الفرشاة، بينما تعمل الأيونات السلبية على إحاطة الشعرة وتقليل الشحنات الساكنة والهيشان للحصول على نتيجة أكثر نعومة وترتيباً.",
      price: 200.0,
      stock: 35,
      categoryId: catElectricHairStylers._id,
      brand: "PUMAS",
      sku: "PUMAS-ELECTRIC-HAIR-BRUSH-CERAMIC-ION",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Mapped to existing hair devices category in current catalog structure.",
        notesAr: "تم ربط المنتج بفئة أجهزة الشعر المتاحة حالياً ضمن هيكل الكتالوج.",
        notesHe: "המוצר מופנה לקטגוריית מכשירי השיער הקיימת במבנה הקטלוג הנוכחי.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PUMAS-ELECTRIC-HAIR-BRUSH-CERAMIC-ION",
        model: "ELECTRIC-HAIR-BRUSH",
        productLine: "Pumas Hair Styling Devices",
      },
      classification: {
        categoryPrimary: "Professional Electric Hair Brush",
        categorySecondary: "Ceramic + Negative Ions",
      },
      specs: {
        plateMaterial: "Ceramic",
        ionicTechnology: "Negative Ions",
        usageMode: "Corded",
      },
      packageIncludes: ["Electric hair brush"],
      packageIncludesAr: ["فرشاة شعر كهربائية"],
      packageIncludesHe: ["מברשת שיער חשמלית"],
      publishContent: {
        seoKeywords: [
          "מברשת שיער חשמלית",
          "מברשת חשמלית לשיער",
          "מברשת יונים",
          "יונים שליליים",
          "משטח קרמי",
          "עיצוב שיער",
          "ייבוש שיער",
          "הפחתת קרזול",
          "חשמל סטטי",
          "שיער מבריק",
          "فرشاة شعر كهربائية",
          "فرشاة كهربائية للشعر",
          "أيونات سلبية",
          "فرشاة أيونية",
          "سيراميك",
          "تصفيف الشعر",
          "تجفيف الشعر",
          "تقليل الهيشان",
          "كهرباء ساكنة",
          "لمعان الشعر",
        ],
        bulletsHe: [
          "מברשת שיער חשמלית מקצועית לייבוש ועיצוב מהירים.",
          "מסייעת להפחתת זמן חשיפה לחום ובכך לצמצום נזק לשיער.",
          "מפחיתה קרזול וחשמל סטטי למראה רך ומבריק יותר.",
          "משטח קרמי איכותי לפיזור חום אחיד.",
          "טכנולוגיית יונים שליליים להפחתת סטטיות ופריז.",
        ],
        bulletsAr: [
          "فرشاة كهربائية احترافية لتجفيف وتصفيف أسرع.",
          "تقلل وقت التعرض للحرارة مما يساعد على تقليل الضرر.",
          "تخفف الهيشان والكهرباء الساكنة لشعر أنعم ولمعان أعلى.",
          "سطح سيراميك لتوزيع حرارة متساوٍ.",
          "تقنية الأيونات السلبية لتقليل الستاتيك والـ frizz.",
        ],
        shortDescHe: "מברשת שיער חשמלית מקצועית – משטח קרמי ויונים שליליים להפחתת קרזול וחשמל סטטי.",
        shortDescAr: "فرشاة شعر كهربائية احترافية – سطح سيراميك وأيونات سلبية لتقليل الهيشان والكهرباء الساكنة.",
      },
      tags: ["pumas", "electric-hair-brush", "ceramic", "negative-ions", "anti-frizz", "hair-styling"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927040/barber-bang/photo_5814267292580253008_x_1771927039745.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927040/barber-bang/photo_5814267292580253008_x_1771927039745.jpg",
          altHe: "מברשת שיער חשמלית",
          altAr: "فرشاة شعر كهربائية",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 28-E
    {
      titleHe: "קוצץ שיער לאף ולאוזן Pumas R75",
      titleAr: "ماكينة تشذيب شعر الأنف والأذن Pumas R75",
      descriptionHe:
        "קוצץ שיער לאף ולאוזן Pumas R75 מאפשר להגיע בקלות ולהסיר שיער לא רצוי באף ובאוזניים ביעילות ובנוחות. הקיצוץ קל, מדויק וללא חריצים או חתכים, עם עבודה חלקה מכל זווית וללא מאמץ. המכשיר תוכנן לבטיחות מרבית: מערכת הגנה מכסה את הלהבים כדי למנוע מגע ישיר עם העור, וכך מסייעת להפחית משיכה ומריטה של שיערות.\nנטען באמצעות כבל USB, זמן טעינה כ־60 דקות וזמן עבודה עד כ־120 דקות כשהסוללה מלאה. עשוי מתכת איכותית לשימוש עמיד לאורך זמן.",
      descriptionAr:
        "ماكينة تشذيب شعر الأنف والأذن Pumas R75 تتيح الوصول بسهولة لإزالة الشعر غير المرغوب فيه داخل الأنف والأذنين بكفاءة وراحة. توفر قصاً سلساً ودقيقاً بدون خدوش أو جروح، ومن أي زاوية دون مجهود. تم تصميمها للسلامة والراحة: نظام حماية يغطي الشفرات لمنع ملامستها المباشرة للجلد، مما يساعد على تقليل شدّ أو نتف الشعر غير المرغوب فيه.\nتُشحن عبر كابل USB، مدة الشحن حوالي 60 دقيقة، ومدة التشغيل عند اكتمال الشحن تصل إلى حوالي 120 دقيقة. مصنوعة من معدن عالي الجودة لصلابة وعمر استخدام أطول.",
      price: 180.0,
      stock: 50,
      categoryId: catTrimmers._id,
      brand: "PUMAS",
      sku: "PUMAS-R75-NOSE-EAR-TRIMMER",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Rechargeable USB specs verified (approx. 60m charge / 120m runtime). Battery architecture wording kept out of marketing text to avoid ambiguity.",
        notesAr: "تم اعتماد مواصفات الشحن USB (شحن ~60 دقيقة / تشغيل ~120 دقيقة). تم تجنب صياغة بنية البطارية في النص التسويقي لتفادي اللبس.",
        notesHe: "אושרו מפרטי טעינת USB (טעינה ~60 דק׳ / עבודה ~120 דק׳). ניסוח ארכיטקטורת הסוללה הושאר מחוץ לטקסט השיווקי כדי למנוע בלבול.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PUMAS-R75-NOSE-EAR-TRIMMER",
        model: "R75",
        productLine: "Pumas Grooming",
      },
      classification: {
        categoryPrimary: "Nose & Ear Hair Trimmer",
        categorySecondary: "Rechargeable USB Trimmer",
      },
      specs: {
        chargingType: "USB",
        chargingTimeMin: 60,
        runtimeMin: 120,
        bodyMaterial: "Metal",
        safetyGuardSystem: true,
        usageMode: "Cordless",
      },
      packageIncludes: ["Pumas R75 trimmer", "USB charging cable"],
      packageIncludesAr: ["ماكينة Pumas R75", "كابل شحن USB"],
      packageIncludesHe: ["קוצץ Pumas R75", "כבל טעינת USB"],
      publishContent: {
        seoKeywords: [
          "קוצץ שיער לאף",
          "קוצץ לאוזן",
          "טרימר לאף",
          "טרימר לאוזניים",
          "Pumas R75",
          "מכונת גילוח",
          "טיפוח לגבר",
          "קוצץ נטען USB",
          "קיצוץ בטוח",
          "קוצץ מתכת",
          "تريمر الأنف",
          "تريمر الأذن",
          "ماكينة شعر الأنف",
          "ماكينة تشذيب",
          "Pumas R75",
          "عناية الرجال",
          "ماكينة حلاقة",
          "شحن USB",
          "قص آمن",
          "تريمر معدن",
        ],
        bulletsHe: [
          "הסרת שיער לא רצוי באף ובאוזניים בקלות.",
          "קיצוץ חלק ללא חריצים וחתכים, מכל זווית.",
          "מערכת הגנה שמכסה את הלהבים למניעת מגע ישיר עם העור.",
          "מפחית משיכה/מריטה של שיערות.",
          "טעינת USB: טעינה ~60 דק׳, עבודה עד ~120 דק׳.",
          "עשוי מתכת איכותית לעמידות גבוהה.",
        ],
        bulletsAr: [
          "إزالة شعر الأنف والأذن بسهولة وبشكل فعّال.",
          "قص سلس ودقيق بدون خدوش أو جروح ومن أي زاوية.",
          "نظام حماية يغطي الشفرات لمنع ملامسة الجلد مباشرة.",
          "يقلل شدّ/نتف الشعر غير المرغوب فيه.",
          "شحن USB: شحن ~60 دقيقة، تشغيل حتى ~120 دقيقة.",
          "مصنوع من معدن عالي الجودة لزيادة المتانة.",
        ],
        shortDescHe: "קוצץ לאף ולאוזן Pumas R75 – קיצוץ בטוח ללא חתכים, טעינת USB וזמן עבודה עד 120 דק׳.",
        shortDescAr: "تريمر أنف وأذن Pumas R75 – قص آمن بدون جروح، شحن USB، تشغيل حتى 120 دقيقة.",
      },
      tags: ["pumas", "r75", "nose-trimmer", "ear-trimmer", "usb-rechargeable", "metal-body"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925806/barber-bang/photo_5814267292580253018_x_1771925806080.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925806/barber-bang/photo_5814267292580253018_x_1771925806080.jpg",
          altHe: "קוצץ Pumas R75 לאף ולאוזן",
          altAr: "ماكينة Pumas R75 للأنف والأذن",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 28-F
    {
      titleHe: "מכונת תספורת וואל קונו – WAHL KUNO",
      titleAr: "ماكينة قص شعر وال كونو – WAHL KUNO",
      descriptionHe:
        "מכונת תספורת מקצועית WAHL KUNO מבית וואל, מיועדת לעבודה מדויקת ומהירה בעמדת הברבר/מספרה. כוללת סכין רחבה ברוחב 46 מ״מ עם כוונון אורך חיתוך מדויק בטווח 0.8–1.8 מ״מ, ומנוע עוצמתי במהירות 7,200 סל״ד (RPM) לביצועים עקביים. מגיעה עם 6 מסרקים מגנטיים במארז לעבודה נוחה ומדויקת במגוון אורכים. זמן עבודה עד 90 דקות וזמן טעינה כ־60 דקות. מאפשרת שימוש גם בחיבור חשמלי וגם במצב נטען (Cord/Cordless), עם כבל באורך 3 מטר לנוחות תנועה. משקל 295 גרם לשילוב בין יציבות לנוחות בעבודה ממושכת.",
      descriptionAr:
        "ماكينة قص شعر احترافية WAHL KUNO من Wahl، مصممة لعمل دقيق وسريع في صالون الحلاقة/الباربر. تأتي بشفرة عريضة بعرض 46 مم مع ضبط لطول القص ضمن نطاق 0.8–1.8 مم، ومحرك قوي بسرعة 7,200 دورة/دقيقة (RPM) لأداء ثابت. تتضمن 6 أمشاط مغناطيسية داخل العلبة لتغطية أطوال متعددة بسهولة. زمن التشغيل يصل إلى 90 دقيقة، وزمن شحن البطارية حوالي 60 دقيقة. يمكن استخدامها على الكهرباء أو بالبطارية (Cord/Cordless)، مع كابل بطول 3 أمتار لحرية حركة أفضل. وزنها 295 غرام لتوازن ممتاز بين الثبات والراحة أثناء الاستخدام الطويل.",
      price: 1040.0,
      stock: 12,
      categoryId: catHairClippers._id,
      brand: "WAHL",
      sku: "WAHL-KUNO-CLIPPER",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Professional clipper specs provided for listing.",
        notesAr: "تم اعتماد مواصفات ماكينة القص الاحترافية للنشر.",
        notesHe: "מפרט מכונת התספורת המקצועית אושר לפרסום.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "WAHL-KUNO-CLIPPER",
        model: "KUNO",
        productLine: "WAHL Professional",
      },
      classification: {
        categoryPrimary: "Professional Hair Clipper",
        categorySecondary: "Cord/Cordless Clipper",
      },
      specs: {
        bladeWidthMm: 46,
        cutLengthMinMm: 0.8,
        cutLengthMaxMm: 1.8,
        motorSpeedRpmMin: 7200,
        motorSpeedRpmMax: 7200,
        chargingTimeMin: 60,
        runtimeMin: 90,
        cableLengthM: 3,
        weightG: 295,
        chargingType: "Cord + Charging",
        usageMode: "Corded&Cordless",
      },
      packageIncludes: ["WAHL KUNO clipper", "6 magnetic guide combs", "Power cable (3m)"],
      packageIncludesAr: ["ماكينة WAHL KUNO", "6 أمشاط مغناطيسية", "كابل طاقة بطول 3 متر"],
      packageIncludesHe: ["מכונת WAHL KUNO", "6 מסרקים מגנטיים", "כבל חשמל באורך 3 מטר"],
      publishContent: {
        seoKeywords: [
          "WAHL KUNO",
          "וואל קונו",
          "מכונת תספורת וואל",
          "מכונת תספורת מקצועית",
          "מכונת ברבר",
          "7200RPM",
          "סכין 46 מ״מ",
          "מסרקים מגנטיים",
          "מכונה נטענת",
          "Cordless",
          "WAHL KUNO",
          "وال كونو",
          "ماكينة قص وال",
          "ماكينة قص احترافية",
          "ماكينة باربر",
          "7200RPM",
          "شفرة 46 مم",
          "أمشاط مغناطيسية",
          "ماكينة لاسلكية",
          "سلكي لاسلكي",
        ],
        bulletsHe: [
          "סכין רחבה 46 מ״מ עם כוונון 0.8–1.8 מ״מ.",
          "מנוע 7,200 RPM לביצועים חזקים ועקביים.",
          "6 מסרקים מגנטיים כלולים במארז.",
          "זמן עבודה עד 90 דקות.",
          "זמן טעינה כ־60 דקות.",
          "שימוש חשמלי וגם נטען (Cord/Cordless).",
          "כבל באורך 3 מטר.",
          "משקל 295 גרם.",
        ],
        bulletsAr: [
          "شفرة بعرض 46 مم مع ضبط طول 0.8–1.8 مم.",
          "محرك بسرعة 7,200RPM لأداء قوي وثابت.",
          "6 أمشاط مغناطيسية مرفقة.",
          "تشغيل حتى 90 دقيقة.",
          "شحن خلال حوالي 60 دقيقة.",
          "استخدام سلكي أو لاسلكي (Cord/Cordless).",
          "طول الكابل 3 أمتار.",
          "الوزن 295 غرام.",
        ],
        shortDescHe: "WAHL KUNO מקצועית – סכין 46 מ״מ 0.8–1.8 מ״מ, 7200RPM, 6 מסרקים מגנטיים, Cord/Cordless.",
        shortDescAr: "WAHL KUNO الاحترافية – شفرة 46 مم (0.8–1.8 مم)، 7200RPM، 6 أمشاط مغناطيسية، سلكي/لاسلكي.",
      },
      tags: ["wahl", "kuno", "professional-clipper", "7200rpm", "magnetic-combs", "corded-cordless"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925886/barber-bang/photo_5814267292580253017_x_1771925886141.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925886/barber-bang/photo_5814267292580253017_x_1771925886141.jpg",
          altHe: "WAHL KUNO מכונת תספורת מקצועית",
          altAr: "WAHL KUNO ماكينة قص احترافية",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 28-G
    {
      titleHe: "מכונת תספורת בארבר Pumas M2500R",
      titleAr: "ماكينة قص شعر باربر Pumas M2500R",
      descriptionHe:
        "מכונת תספורת מקצועית Pumas M2500R מסדרת הבארבר של פומאס, מיועדת לעבודה מדויקת ומהירה במספרה/ברברשופ. כוללת סוללת ליתיום-איון עוצמתית בקיבולת 2500mAh לעבודה רציפה, להבים חדים ומדויקים לחיתוך נקי, ו־6 מסרקים בגדלים שונים להתאמה למגוון אורכים וסגנונות. המנוע מספק מהירות גבוהה של 10,000RPM לביצועים עקביים, ובנוי כמנוע מגנטי המסייע בשמירה על חיי המנוע לאורך זמן.",
      descriptionAr:
        "ماكينة قص شعر احترافية Pumas M2500R من سلسلة الباربر من Pumas، مصممة للعمل الدقيق والسريع في الصالون/الباربر. مزوّدة ببطارية ليثيوم-أيون قوية بسعة 2500mAh لتشغيل ثابت، وشفرات حادة ودقيقة لقص نظيف. تأتي مع 6 أمشاط بأحجام مختلفة لتغطية أطوال متعددة بسهولة. يعمل المحرك بسرعة عالية تصل إلى 10,000 دورة/دقيقة (RPM) لتقديم أداء ثابت، مع محرك مغناطيسي يساعد على إطالة عمر المحرك والحفاظ على كفاءته.",
      price: 550.0,
      stock: 16,
      categoryId: catHairClippers._id,
      brand: "Pumas",
      sku: "PUM-M2500R-BARBER",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Barber series specs provided for catalog publishing.",
        notesAr: "تم اعتماد مواصفات سلسلة الباربر للنشر في الكتالوج.",
        notesHe: "מפרט סדרת הבארבר אושר לפרסום בקטלוג.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PUM-M2500R-BARBER",
        model: "M2500R",
        productLine: "Pumas Barber Series",
      },
      classification: {
        categoryPrimary: "Professional Barber Clipper",
        categorySecondary: "Barber Series",
      },
      specs: {
        batteryMah: 2500,
        motorSpeedRpmMin: 10000,
        motorSpeedRpmMax: 10000,
        motorType: "Magnetic",
        bladeType: "Precision cutting blade",
        speedLevels: 1,
        usageMode: "Cordless",
      },
      packageIncludes: ["Pumas M2500R clipper", "6 guide combs"],
      packageIncludesAr: ["ماكينة Pumas M2500R", "6 أمشاط بأحجام مختلفة"],
      packageIncludesHe: ["מכונת Pumas M2500R", "6 מסרקים בגדלים שונים"],
      publishContent: {
        seoKeywords: [
          "מכונת תספורת פומאס",
          "Pumas M2500R",
          "מכונת תספורת מקצועית",
          "מכונת בארבר",
          "10000RPM",
          "סוללת 2500mAh",
          "מנוע מגנטי",
          "מסרקים למכונה",
          "להבים חדים",
          "ציוד למספרה",
          "ماكينة قص Pumas",
          "Pumas M2500R",
          "ماكينة قص احترافية",
          "ماكينة باربر",
          "10000RPM",
          "بطارية 2500mAh",
          "محرك مغناطيسي",
          "أمشاط ماكينة قص",
          "شفرات حادة",
          "معدات صالون",
        ],
        bulletsHe: [
          "מכונת תספורת מקצועית מסדרת הבארבר של Pumas.",
          "סוללת ליתיום-איון 2500mAh לעבודה רציפה.",
          "להבים חדים ומדויקים לחיתוך נקי.",
          "מהירות מנוע 10,000RPM לביצועים גבוהים.",
          "מנוע מגנטי לשמירה על חיי המנוע.",
          "6 מסרקים בגדלים שונים כלולים.",
        ],
        bulletsAr: [
          "ماكينة قص احترافية من سلسلة Barber من Pumas.",
          "بطارية ليثيوم-أيون بسعة 2500mAh لتشغيل قوي.",
          "شفرات حادة ودقيقة لقص نظيف.",
          "سرعة محرك 10,000RPM لأداء عالٍ.",
          "محرك مغناطيسي للمساعدة على إطالة عمر المحرك.",
          "6 أمشاط بأحجام مختلفة مرفقة.",
        ],
        shortDescHe: "Pumas M2500R Barber – 10,000RPM, סוללת 2500mAh, להבים מדויקים ו־6 מסרקים.",
        shortDescAr: "Pumas M2500R Barber – 10,000RPM، بطارية 2500mAh، شفرات دقيقة و6 أمشاط.",
      },
      tags: ["pumas", "m2500r", "barber-clipper", "10000rpm", "2500mah", "magnetic-motor", "professional"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925735/barber-bang/photo_5814267292580253021_x__1__1771925735155.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771925735/barber-bang/photo_5814267292580253021_x__1__1771925735155.jpg",
          altHe: "Pumas M2500R מכונת תספורת בארבר",
          altAr: "Pumas M2500R ماكينة قص باربر",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 28-H
    {
      titleHe: "WAHL – סט מכונת תספורת וטרימר נטענים (Beret Stealth + Cordless Super Taper 08592-017H)",
      titleAr: "WAHL – طقم ماكينة قص + تريمر قابلين للشحن (Beret Stealth + Cordless Super Taper 08592-017H)",
      descriptionHe:
        "סט מקצועי מבית WAHL הכולל מכונת תספורת Cordless Super Taper וטרימר Beret Stealth, לשימוש אלחוטי וחשמלי (Cord/Cordless) לעבודה רציפה בעמדת הברבר/מספרה. מכונת התספורת Cordless Super Taper מצוידת במנוע DC במהירות 5,500 סל״ד, סוללת ליתיום-יון לזמן עבודה של 100 דקות מינימום וזמן טעינה כ־120 דקות. כוללת להבי כרום קבועים עם ידית לשינוי גובה, גובה חיתוך 1–2 מ״מ ורוחב חיתוך 46 מ״מ. הטרימר Beret Stealth כולל מנוע DC במהירות 6,000 סל״ד, סוללת ליתיום-יון לזמן עבודה של 75 דקות מינימום וזמן טעינה כ־60 דקות. מגיע עם להבי כרום שחור בהחלפה מהירה, גובה חיתוך 0.4 מ״מ ורוחב חיתוך 32.5 מ״מ. שילוב מושלם לסט עבודה מקצועי: חיתוך ראש מדויק לצד גימורים, קווי מתאר ועבודה מפורטת.",
      descriptionAr:
        "طقم احترافي من WAHL يضم ماكينة قص Cordless Super Taper وتريمر Beret Stealth، وكلاهما يدعم الاستخدام اللاسلكي والسلكي (Cord/Cordless) للعمل المتواصل في الصالون/الباربر. ماكينة Cordless Super Taper تأتي بمحرك DC بسرعة 5,500 دورة/دقيقة، وبطارية ليثيوم-أيون بزمن تشغيل لا يقل عن 100 دقيقة وزمن شحن حوالي 120 دقيقة. تحتوي على شفرات كروم ثابتة مع ذراع لتغيير الارتفاع، طول قص 1–2 مم وعرض قص 46 مم. أما تريمر Beret Stealth فيأتي بمحرك DC بسرعة 6,000 دورة/دقيقة، وبطارية ليثيوم-أيون بزمن تشغيل لا يقل عن 75 دقيقة وزمن شحن حوالي 60 دقيقة. مزوّد بشفرات كروم سوداء مع تبديل سريع، طول قص 0.4 مم وعرض قص 32.5 مم. اختيار ممتاز لباقة عمل كاملة تجمع بين قص الشعر الرئيسي والتحديدات الدقيقة وخطوط الحواف.",
      price: 750.0,
      stock: 10,
      categoryId: catBundles._id,
      brand: "WAHL",
      sku: "WAHL-KIT-SUPERTAPER-BERET-08592-017H",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "A",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Professional WAHL kit specs provided for listing.",
        notesAr: "تم اعتماد مواصفات طقم WAHL الاحترافي للنشر.",
        notesHe: "מפרט סט WAHL מקצועי אושר לפרסום.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "WAHL-KIT-SUPERTAPER-BERET-08592-017H",
        model: "Beret Stealth + Cordless Super Taper 08592-017H",
        productLine: "WAHL Professional Kits",
      },
      classification: {
        categoryPrimary: "Professional Clipper & Trimmer Kit",
        categorySecondary: "Cord/Cordless Barber Set",
      },
      specs: {
        usageMode: "Corded&Cordless",
        kitType: "Clipper + Trimmer",
        superTaper: {
          motorType: "DC",
          motorSpeedRpm: 5500,
          batteryType: "Lithium-Ion",
          runtimeMin: 100,
          chargingTimeMin: 120,
          cutLengthMinMm: 1,
          cutLengthMaxMm: 2,
          bladeWidthMm: 46,
          bladeType: "Fixed chrome blade with taper lever",
        },
        beretStealth: {
          motorType: "DC",
          motorSpeedRpm: 6000,
          batteryType: "Lithium-Ion",
          runtimeMin: 75,
          chargingTimeMin: 60,
          cutLengthMinMm: 0.4,
          bladeWidthMm: 32.5,
          bladeType: "Quick-change black chrome blade",
        },
      },
      packageIncludes: ["Cordless Super Taper clipper", "Beret Stealth trimmer", "Charging accessories"],
      packageIncludesAr: ["ماكينة Cordless Super Taper", "تريمر Beret Stealth", "ملحقات الشحن"],
      packageIncludesHe: ["מכונת Cordless Super Taper", "טרימר Beret Stealth", "אביזרי טעינה"],
      publishContent: {
        seoKeywords: [
          "WAHL",
          "סט וואל",
          "Cordless Super Taper",
          "Beret Stealth",
          "08592-017H",
          "מכונת תספורת נטענת",
          "טרימר נטען",
          "סט ברבר",
          "מכונת תספורת מקצועית",
          "טרימר מקצועי",
          "Cord/Cordless",
          "WAHL",
          "طقم وال",
          "Cordless Super Taper",
          "Beret Stealth",
          "08592-017H",
          "ماكينة قص قابلة للشحن",
          "تريمر قابل للشحن",
          "طقم باربر",
          "ماكينة قص احترافية",
          "تريمر احترافي",
          "سلكي ولاسلكي",
        ],
        bulletsHe: [
          "סט WAHL: מכונת תספורת Cordless Super Taper + טרימר Beret Stealth.",
          "שני המכשירים לשימוש אלחוטי וחשמלי (Cord/Cordless) עם פעולה חשמלית רציפה.",
          "Super Taper: מנוע 5,500 סל״ד, זמן עבודה 100 דק׳ מינ׳, טעינה 120 דק׳, חיתוך 1–2 מ״מ, רוחב 46 מ״מ.",
          "Beret Stealth: מנוע 6,000 סל״ד, זמן עבודה 75 דק׳ מינ׳, טעינה 60 דק׳, חיתוך 0.4 מ״מ, רוחב 32.5 מ״מ.",
          "אידיאלי לשילוב בין תספורת מלאה לגימורים מדויקים וקווי מתאר.",
        ],
        bulletsAr: [
          "طقم WAHL: ماكينة قص Cordless Super Taper + تريمر Beret Stealth.",
          "الجهازان يعملان سلكياً ولاسلكياً (Cord/Cordless) مع تشغيل كهربائي مستمر.",
          "Super Taper: محرك 5,500RPM، تشغيل ≥100 دقيقة، شحن 120 دقيقة، قص 1–2 مم، عرض 46 مم.",
          "Beret Stealth: محرك 6,000RPM، تشغيل ≥75 دقيقة، شحن 60 دقيقة، قص 0.4 مم، عرض 32.5 مم.",
          "مثالي للجمع بين قص كامل وتحديد دقيق وخطوط حواف.",
        ],
        shortDescHe: "סט WAHL מקצועי: Cordless Super Taper + Beret Stealth – שימוש חשמלי/אלחוטי, נתונים מקצועיים ושני כלים משלימים.",
        shortDescAr: "طقم WAHL احترافي: Super Taper + Beret Stealth – سلكي/لاسلكي، مواصفات قوية، وأداتان متكاملتان للقص والتحديد.",
      },
      tags: ["wahl", "barber-kit", "super-taper", "beret-stealth", "08592-017h", "corded-cordless", "professional-set"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926117/barber-bang/photo_5814267292580253020_x__1__1771926116604.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926117/barber-bang/photo_5814267292580253020_x__1__1771926116604.jpg",
          altHe: "סט WAHL מקצועי - Super Taper + Beret Stealth",
          altAr: "طقم WAHL احترافي - Super Taper + Beret Stealth",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 28-I
    {
      titleHe: "באנדל מכונות Pumas – 155R + 300R + 75R",
      titleAr: "باقة ماكينات Pumas – 155R + 300R + 75R",
      descriptionHe:
        "באנדל מכונות Pumas הכולל 3 מכשירים משלימים לטיפוח וגילוח: מכונת תספורת לגוף Pumas R155 עם להב בטכנולוגיה מיוחדת למניעת גירויים וחיתוכים, מיועדת לגילוח שיער באזורים רגישים במיוחד. המכונה עמידה במים ומאפשרת שימוש גם במקלחת. זמן טעינה כ־120 דקות וזמן עבודה עד כ־120 דקות כשהסוללה מלאה. קוצץ שיער לאף ולאוזן Pumas R75 להסרה יעילה של שיער לא רצוי באף ובאוזניים—קיצוץ קל וללא חריצים או חתכים, מכל זווית. תוכנן לבטיחות ונוחות עם מערכת הגנה שמכסה את הלהבים ומפחיתה מגע ישיר עם העור, כדי לסייע במניעת משיכה ומריטה של שיערות. מכונת תספורת לעיצוב Pumas 300R – מכונה שקטה מאוד, חדה ומהירה, עם טעינה מהירה: 30 דקות טעינה מעניקות עד כ־100 דקות עבודה. הבאנדל מספק פתרון מלא: גוף (כולל אזורים רגישים), גימורים/עיצוב, וטיפוח מדויק לאף ולאוזן.",
      descriptionAr:
        "باقة ماكينات Pumas تضم 3 أجهزة متكاملة للعناية والحلاقة: ماكينة تشذيب للجسم Pumas R155 بشفرة بتقنية خاصة للمساعدة في تقليل التهيّج والخدوش/الجروح، مناسبة لإزالة شعر الجسم خصوصاً في المناطق الحساسة. الماكينة مقاومة للماء ويمكن استخدامها أثناء الاستحمام. مدة الشحن حوالي 120 دقيقة ومدة التشغيل حتى حوالي 120 دقيقة عند اكتمال الشحن. تريمر الأنف والأذن Pumas R75 لإزالة الشعر غير المرغوب فيه داخل الأنف والأذنين بكفاءة—قص سهل وآمن بدون خدوش أو جروح ومن أي زاوية. مصمم للراحة والسلامة مع نظام حماية يغطي الشفرات ويقلل ملامستها المباشرة للجلد، مما يساعد على تقليل شدّ/نتف الشعر. ماكينة تشذيب للتحديد والتصفيف Pumas 300R—هادئة جداً، حادة وسريعة، مع شحن سريع: 30 دقيقة شحن تمنح حتى حوالي 100 دقيقة تشغيل. توفر هذه الباقة حلاً كاملاً: للجسم (بما في ذلك المناطق الحساسة)، للتحديد/التصفيف، وللعناية الدقيقة بالأنف والأذن.",
      price: 720.0,
      salePrice: 665.0,
      saleStartAt: nowPlusDays(-1),
      saleEndAt: nowPlusDays(30),
      stock: 14,
      categoryId: catBundles._id,
      brand: "Pumas",
      sku: "PUM-BUNDLE-155R-300R-75R",
      unit: "set",
      netQuantity: 3,
      sizeLabel: "3 devices bundle",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Bundle composition and pricing provided for publish-ready listing.",
        notesAr: "تم اعتماد مكونات الباقة وأسعارها كنص جاهز للنشر.",
        notesHe: "תכולת הבאנדל והתמחור אושרו כתוכן מוכן לפרסום.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "PUM-BUNDLE-155R-300R-75R",
        model: "155R-300R-75R",
        productLine: "Pumas Bundles",
      },
      classification: {
        categoryPrimary: "Clipper & Trimmer Bundle",
        categorySecondary: "Barber/Grooming Kit",
      },
      specs: {
        usageMode: "Cordless",
        bundleItemsCount: 3,
        bundleRegularPrice: 720,
        bundleSalePrice: 665,
        r155ChargingTimeMin: 120,
        r155RuntimeMin: 120,
        r300rChargingTimeMin: 30,
        r300rRuntimeMin: 100,
      },
      packageIncludes: ["Pumas R155 body trimmer", "Pumas 300R styling trimmer", "Pumas R75 nose & ear trimmer"],
      packageIncludesAr: ["ماكينة تشذيب للجسم Pumas R155", "ماكينة تشذيب للتحديد Pumas 300R", "تريمر الأنف والأذن Pumas R75"],
      packageIncludesHe: ["מכונת תספורת לגוף Pumas R155", "מכונת תספורת לעיצוב Pumas 300R", "קוצץ שיער לאף ולאוזן Pumas R75"],
      publishContent: {
        seoKeywords: [
          "באנדל מכונות",
          "סט מכונות תספורת",
          "Pumas 155R",
          "Pumas 300R",
          "Pumas R75",
          "מכונת תספורת לגוף",
          "מכונה עמידה במים",
          "טרימר לעיצוב",
          "קוצץ לאף ולאוזן",
          "טיפוח לגבר",
          "باقة ماكينات",
          "طقم ماكينات",
          "Pumas 155R",
          "Pumas 300R",
          "Pumas R75",
          "ماكينة للجسم",
          "ماكينة مقاومة للماء",
          "تريمر تحديد",
          "تريمر الأنف والأذن",
          "عناية الرجال",
        ],
        bulletsHe: [
          "באנדל מכונות Pumas הכולל 3 מכשירים משלימים לטיפוח וגילוח.",
          "Pumas R155 (לגוף): להב נגד גירויים/חתכים, עמיד במים לשימוש במקלחת, טעינה 120 דק׳, עבודה 120 דק׳.",
          "Pumas R75 (אף/אוזן): קיצוץ בטוח ללא חתכים, מערכת הגנה ללהבים להפחתת משיכה/מריטה.",
          "Pumas 300R (עיצוב): שקטה מאוד, חדה ומהירה, טעינה מהירה—30 דק׳ טעינה ≈ 100 דק׳ עבודה.",
          "פתרון מלא לשימוש יומיומי/מקצועי: גוף, עיצוב וגימורים, אף ואוזן.",
        ],
        bulletsAr: [
          "باقة تضم 3 ماكينات متكاملة للعناية والحلاقة.",
          "Pumas R155 (للجسم): شفرة تقلل التهيّج والخدوش، مقاومة للماء للاستخدام في الدش، شحن 120 دقيقة، تشغيل 120 دقيقة.",
          "Pumas R75 (أنف/أذن): قص آمن بدون جروح، نظام حماية للشفرات لتقليل شدّ/نتف الشعر.",
          "Pumas 300R (تحديد/تصفيف): هادئة جداً وحادة وسريعة، شحن سريع—30 دقيقة ≈ 100 دقيقة تشغيل.",
          "حل شامل للجسم والتحديد والعناية الدقيقة بالأنف والأذن.",
        ],
        shortDescHe: "באנדל Pumas 3 מכונות: R155 לגוף (עמיד במים) + 300R לעיצוב (טעינה מהירה) + R75 לאף/אוזן.",
        shortDescAr: "باقة Pumas (3 أجهزة): R155 للجسم مقاومة للماء + 300R للتحديد بشحن سريع + R75 للأنف والأذن.",
      },
      tags: ["pumas", "bundle", "155r", "300r", "r75", "barber-kit", "grooming-kit"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926211/barber-bang/photo_5814267292580253019_x_1771926210889.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771926211/barber-bang/photo_5814267292580253019_x_1771926210889.jpg",
          altHe: "באנדל מכונות Pumas 155R + 300R + 75R",
          altAr: "باقة ماكينات Pumas 155R + 300R + 75R",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
    // 29
    {
      titleHe: "מכשיר לחימום שעווה (Smart Wax Heater)",
      titleAr: "جهاز تسخين الشمع (Smart Wax Heater)",
      descriptionHe:
        "מכשיר חכם לחימום שעווה עם פאנל בקרה דיגיטלי עמיד ומעוצב, המיועד לחימום מהיר ומדויק של שעווה לשימוש ביתי או מקצועי. המכשיר כולל סיר פנימי גדול עם ידית לנוחות בזמן עבודה וניקוי, וחיישן טמפרטורה שמזהה ומציג את הטמפרטורה המדויקת בזמן אמת. עוצמת חימום גבוהה ממיסה את השעווה במהירות ובאופן יסודי, בעוד בקרת הטמפרטורה המדויקת מסייעת להפחתת סיכון לכוויות ולהתאמת הטמפרטורה לסוג השעווה והעור.",
      descriptionAr:
        "جهاز تسخين شمع ذكي مزوّد بلوحة تحكم رقمية متينة وأنيقة، مصمم لتسخين الشمع بسرعة ودقة للاستخدام المنزلي أو المهني. يحتوي على وعاء داخلي بسعة كبيرة مع مقبض لسهولة الاستخدام والإزالة، بالإضافة إلى حساس حرارة يقوم باكتشاف وعرض درجة الحرارة الدقيقة بشكل مباشر. التسخين عالي القوة يساعد على إذابة الشمع بسرعة وبشكل متجانس، بينما التحكم الدقيق بدرجة الحرارة يساهم في تقليل خطر حروق الجلد الناتجة عن الحرارة العالية ويتيح ضبط الحرارة بما يناسب نوع الشمع والبشرة.",
      price: 250.0,
      stock: 35,
      categoryId: catWaxHairRemoval._id,
      brand: "Smart Wax Heater",
      sku: "SWH-WAX-HEATER-DIGITAL",
      catalogStatus: "READY_WITH_EDITS",
      confidenceGrade: "B",
      verification: {
        isModelVerified: true,
        isCategoryVerified: true,
        verifiedSourcesCount: 1,
        lastVerifiedAt: nowPlusDays(-1),
        notes: "Publish-ready device content provided.",
        notesAr: "تم تزويد وصف كامل وجاهز للنشر للجهاز.",
        notesHe: "סופק תוכן מלא ומוכן לפרסום עבור המכשיר.",
        hasCriticalMismatch: false,
      },
      identity: {
        internalSku: "SWH-WAX-HEATER-DIGITAL",
        model: "SMART-WAX-HEATER",
        productLine: "Wax Heating Devices",
      },
      classification: {
        categoryPrimary: "Smart Wax Heater",
        categorySecondary: "Electric Wax Heater",
      },
      specs: {
        displayType: "Digital Control Panel",
        usageMode: "Corded",
      },
      packageIncludes: ["Smart wax heater unit", "Large inner pot with handle"],
      packageIncludesAr: ["جهاز تسخين الشمع الذكي", "وعاء داخلي كبير مع مقبض"],
      packageIncludesHe: ["מכשיר חימום שעווה חכם", "סיר פנימי גדול עם ידית"],
      publishContent: {
        seoKeywords: [
          "Smart Wax Heater",
          "wax heater",
          "wax warming device",
          "מחמם שעווה",
          "מכשיר שעווה",
          "חימום שעווה",
          "הסרת שיער",
          "מכשיר להסרת שיער",
          "ווקס",
          "שעווה מקצועית",
          "בקרה דיגיטלית",
          "חיישן טמפרטורה",
          "جهاز تسخين الشمع",
          "سخان شمع",
          "تسخين الشمع",
          "إزالة الشعر",
          "جهاز إزالة الشعر",
          "شمع",
          "واكس",
          "تحكم رقمي",
          "حساس حرارة",
          "درجة حرارة دقيقة",
        ],
        bulletsHe: [
          "פאנל בקרה דיגיטלי עמיד ומעוצב.",
          "סיר פנימי גדול עם ידית לנוחות שימוש והוצאה.",
          "חיישן טמפרטורה מציג טמפרטורה מדויקת בזמן אמת.",
          "חימום בעוצמה גבוהה להמסה מהירה ויסודית של השעווה.",
          "בקרת טמפרטורה מדויקת להפחתת סיכון לכוויות והתאמה לעור.",
        ],
        bulletsAr: [
          "لوحة تحكم رقمية متينة وأنيقة.",
          "وعاء داخلي كبير مع مقبض لسهولة الاستخدام.",
          "حساس حرارة يعرض درجة الحرارة الدقيقة بشكل مباشر.",
          "تسخين قوي لذوبان أسرع وأكثر تجانساً.",
          "تحكم دقيق بالحرارة لتقليل خطر حروق الجلد.",
        ],
        shortDescHe: "מחמם שעווה חכם עם בקרה דיגיטלית, חימום מהיר וחיישן טמפרטורה מדויק.",
        shortDescAr: "سخان شمع ذكي بتحكم رقمي، تسخين سريع، وحساس حرارة لعرض الدرجة بدقة.",
      },
      tags: ["smart-wax-heater", "wax-heater", "hair-removal", "digital-control", "temperature-sensor", "beauty-device"],
      images: [
        {
          url: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927252/barber-bang/photo_5814267292580253011_x_1771927251632.jpg",
          secureUrl: "https://res.cloudinary.com/dvcpd6tye/image/upload/v1771927252/barber-bang/photo_5814267292580253011_x_1771927251632.jpg",
          altHe: "מכשיר לחימום שעווה",
          altAr: "جهاز تسخين الشمع",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
  ];

  console.log(`🧴 Creating products (${productsInput.length} items)...`);

  const prepared = productsInput.map((p) => {
    const slug = slugFromSku(p.sku) || undefined;
    const priceMinor = toMinorSafe(p.price);
    const salePriceMinor = p.salePrice != null ? toMinorSafe(p.salePrice) : null;
    const resolvedCategoryKey = resolveProductCategoryKey(p);

    if (!resolvedCategoryKey) {
      throw new Error(`Could not resolve category for product SKU ${p.sku}`);
    }

    const resolvedCategory = categoryByKey.get(resolvedCategoryKey);
    if (!resolvedCategory) {
      throw new Error(`Resolved category key '${resolvedCategoryKey}' is missing for SKU ${p.sku}`);
    }

    const orderedKeys = [...NON_DEVICE_CATEGORY_PRIORITY, ...DEVICE_CATEGORY_PRIORITY];
    const declaredPrimaryKey = detectCategoryKey(p?.classification?.categoryPrimary || "", orderedKeys);

    const legacyCategoryId = p?.categoryId ? String(p.categoryId) : "";
    const resolvedCategoryId = String(resolvedCategory._id);
    const clipperCategoryId = String(catHairClippers?._id || "");

    if (declaredPrimaryKey && declaredPrimaryKey !== resolvedCategoryKey) {
      console.warn(
        `⚠️ Primary classification/categoryId mismatch for ${p.sku}: categoryPrimary=${p.classification?.categoryPrimary} -> ${declaredPrimaryKey}, resolved=${resolvedCategoryKey}`
      );
    }

    if (legacyCategoryId && legacyCategoryId !== resolvedCategoryId) {
      console.warn(
        `⚠️ categoryId mismatch for ${p.sku}: inputCategoryId=${legacyCategoryId}, resolvedCategoryId=${resolvedCategoryId} (${resolvedCategoryKey})`
      );
    }

    if (resolvedCategoryKey === CATEGORY_KEY.HAIR_DRYERS_BLOWERS && legacyCategoryId === clipperCategoryId) {
      console.warn(`⚠️ Guard: ${p.sku} is Hair Dryer/Blower and cannot remain under Hair Clippers.`);
    }
    if (resolvedCategoryKey === CATEGORY_KEY.ELECTRIC_HAIR_STYLERS && legacyCategoryId === clipperCategoryId) {
      console.warn(`⚠️ Guard: ${p.sku} is Electric Hair Styler and cannot remain under Hair Clippers.`);
    }

    const classification = {
      ...(p.classification || {}),
      categoryPrimary: CATEGORY_PRIMARY_BY_KEY[resolvedCategoryKey] || p?.classification?.categoryPrimary || "",
      categorySecondary:
        p?.classification?.categorySecondary || CATEGORY_SECONDARY_BY_KEY[resolvedCategoryKey] || "",
    };

    return {
      ...p,
      categoryId: resolvedCategory._id,
      classification,
      slug,
      priceMinor,
      salePriceMinor,
      isActive: true,
      trackInventory: true,
      allowBackorder: false,
      discountPercent: null,
    };
  });

  const created = await Product.create(prepared);

  console.log(`✅ Products created: ${created.length}`);
  return created;
}

async function createShipping() {
  console.log("🚚 Creating shipping config...");

  const [areas, points, storePickup] = await Promise.all([
    DeliveryArea.create([
      { nameHe: "עכו", nameAr: "عكا", fee: 20, isActive: true },
      { nameHe: "חיפה", nameAr: "حيفا", fee: 25, isActive: true },
      { nameHe: "נהריה", nameAr: "نهاريا", fee: 25, isActive: true },
      { nameHe: "כרמיאל", nameAr: "كرميئيل", fee: 30, isActive: true },
      { nameHe: "צפת", nameAr: "صفد", fee: 35, isActive: true },
      { nameHe: "טבריה", nameAr: "طبريا", fee: 35, isActive: true },
    ]),
    PickupPoint.create([
      {
        nameHe: "נקודת איסוף - עכו מרכז",
        nameAr: "نقطة استلام - مركز عكا",
        addressHe: "עכו, דרך הארבעה 24",
        addressAr: "عكا, طريق الأربعة 24",
        fee: 10,
        isActive: true,
      },
      {
        nameHe: "נקודת איסוף - חיפה מרכז",
        nameAr: "نقطة استلام - مركز حيفا",
        addressHe: "חיפה, מרכז הכרמל",
        addressAr: "حيفا, مركز الكرمل",
        fee: 12,
        isActive: true,
      },
    ]),
    StorePickupConfig.create({
      isEnabled: true,
      fee: 0,
      addressHe: STORE.addressHe,
      addressAr: STORE.addressAr,
      notesHe: `איסוף מהחנות בתיאום מראש בוואטסאפ ${STORE.whatsapp}.`,
      notesAr: `استلام من المتجر بعد التنسيق المسبق عبر واتساب ${STORE.whatsapp}.`,
      address: STORE.addressEn,
      notes: `Store pickup by WhatsApp appointment: ${STORE.whatsapp}.`,
    }),
  ]);

  console.log("✅ Shipping config created");
  return { areas, points, storePickup };
}

/* =========================================
   Site settings + Content + Home layout (Unified)
========================================= */
async function createSettings() {
  console.log("⚙️ Creating SiteSettings + HomeLayout + Content pages...");

  const settings = await SiteSettings.create({
    storeNameHe: STORE.nameHe,
    storeNameAr: STORE.nameAr,
    logoUrl: "",
    faviconUrl: "",
    whatsappNumber: STORE.whatsapp,
    phone: STORE.phone,
    email: STORE.email,
    addressHe: STORE.addressHe,
    addressAr: STORE.addressAr,
    businessHoursHe: STORE.businessHoursHe,
    businessHoursAr: STORE.businessHoursAr,
    socialLinks: {
      instagram: "",
      facebook: "",
      tiktok: "",
    },
    topBar: {
      enabled: true,
      textHe: "משלוח מהיר | מוצרים מקוריים | תשלום במזומן (COD)",
      textAr: "شحن سريع | منتجات أصلية | الدفع عند الاستلام (COD)",
      link: "/shop",
    },
    seoDefaults: {
      titleHe: `${STORE.brandDisplayHe} | טיפוח, גילוח ועיצוב מקצועי`,
      titleAr: `${STORE.brandDisplayAr} | عناية، حلاقة وتصفيف احترافي`,
      descriptionHe: "מוצרים מקוריים באיכות גבוהה עם משלוח מהיר ושירות מקצועי.",
      descriptionAr: "منتجات أصلية بجودة عالية مع شحن سريع وخدمة احترافية.",
      ogImage: "",
    },
    maintenanceMode: {
      enabled: false,
      messageHe: "",
      messageAr: "",
    },
    checkoutRules: {
      enableCOD: true,
      codFeeMinor: 1500, // 15₪
      freeShippingThresholdMinor: 19900, // 199₪
      minOrderAmountMinor: 3000, // 30₪
    },
  });

  const pages = await ContentPage.create([
    {
      slug: "about",
      titleHe: "אודות",
      titleAr: "من نحن",
      contentHe: `${STORE.nameHe} היא חנות למוצרי טיפוח לגברים הפועלת מ-${STORE.addressHe}.
אנו מספקים מוצרי גילוח, תספורת ועיצוב באיכות גבוהה עם שירות מקצועי ושקיפות מלאה.
טלפון: ${STORE.phone}
וואטסאפ: ${STORE.whatsapp}
אימייל: ${STORE.email}
${STORE.legalDisclaimerHe}`,
      contentAr: `${STORE.nameAr} هو متجر لمنتجات العناية الرجالية يعمل من ${STORE.addressAr}.
نوفّر منتجات حلاقة، قص وتصفيف بجودة عالية مع خدمة مهنية وشفافية كاملة.
الهاتف: ${STORE.phone}
واتساب: ${STORE.whatsapp}
البريد: ${STORE.email}
${STORE.legalDisclaimerAr}`,
      isActive: true,
      sortOrder: 10,
    },
    {
      slug: "contact",
      titleHe: "יצירת קשר",
      titleAr: "اتصل بنا",
      contentHe: `טלפון: ${STORE.phone}
וואטסאפ: ${STORE.whatsapp}
אימייל: ${STORE.email}
כתובת: ${STORE.addressHe}
שעות פעילות: ${STORE.businessHoursHe}
לפניות משפטיות/ביטול בכתב: ${STORE.legalNoticeEmail}`,
      contentAr: `الهاتف: ${STORE.phone}
واتساب: ${STORE.whatsapp}
البريد: ${STORE.email}
العنوان: ${STORE.addressAr}
ساعات العمل: ${STORE.businessHoursAr}
للإشعارات القانونية/إلغاء خطيًا: ${STORE.legalNoticeEmail}`,
      isActive: true,
      sortOrder: 20,
    },
    {
      slug: "shipping",
      titleHe: "משלוחים ואספקה",
      titleAr: "الشحن والتسليم",
      contentHe: `אנו מציעים משלוח עד הבית, נקודות איסוף ואיסוף עצמי.
${STORE.shippingNoteHe}`,
      contentAr: `نوفر توصيلًا للمنزل، نقاط استلام، واستلامًا ذاتيًا.
${STORE.shippingNoteAr}`,
      isActive: true,
      sortOrder: 30,
    },
    {
      slug: "returns",
      titleHe: "החזרות והחלפות",
      titleAr: "الإرجاع والاستبدال",
      contentHe: `החזרות/החלפות כפופות לדין החל בישראל.
${STORE.hygieneNoteHe}
להגשת בקשה: ${STORE.legalNoticeEmail}`,
      contentAr: `الإرجاع/الاستبدال يخضع للقانون الساري في إسرائيل.
${STORE.hygieneNoteAr}
لتقديم طلب: ${STORE.legalNoticeEmail}`,
      isActive: true,
      sortOrder: 40,
    },
    {
      slug: "cancellation",
      titleHe: "ביטול עסקה",
      titleAr: "إلغاء الصفقة",
      contentHe: `ביטול עסקה בהתאם לדין החל בישראל.
הודעת ביטול בכתב: ${STORE.legalNoticeEmail} / ${STORE.whatsapp}`,
      contentAr: `إلغاء الصفقة وفقًا للقانون الساري في إسرائيل.
إشعار الإلغاء خطيًا: ${STORE.legalNoticeEmail} / ${STORE.whatsapp}`,
      isActive: true,
      sortOrder: 50,
    },
    {
      slug: "privacy",
      titleHe: "מדיניות פרטיות",
      titleAr: "سياسة الخصوصية",
      contentHe: `אנו שומרים על פרטיות המשתמשים ונוקטים אמצעי אבטחה סבירים בהתאם לדין החל.
לשאלות פרטיות: ${STORE.legalNoticeEmail}
${STORE.legalDisclaimerHe}`,
      contentAr: `نحافظ على خصوصية المستخدمين ونتخذ تدابير أمنية معقولة وفقًا للقانون الساري.
لاستفسارات الخصوصية: ${STORE.legalNoticeEmail}
${STORE.legalDisclaimerAr}`,
      isActive: true,
      sortOrder: 60,
    },
    {
      slug: "terms",
      titleHe: "תקנון ותנאי שימוש",
      titleAr: "الشروط والأحكام",
      contentHe: `השימוש באתר והרכישה כפופים לתנאים אלה ולדין החל בישראל.
משלוחים: ${STORE.shippingNoteHe}
יצירת קשר: ${STORE.phone} | ${STORE.email}
${STORE.legalDisclaimerHe}`,
      contentAr: `استخدام الموقع والشراء يخضعان لهذه الشروط وللقانون الساري في إسرائيل.
الشحن: ${STORE.shippingNoteAr}
التواصل: ${STORE.phone} | ${STORE.email}
${STORE.legalDisclaimerAr}`,
      isActive: true,
      sortOrder: 70,
    },
    {
      slug: "cookies",
      titleHe: "מדיניות עוגיות (Cookies)",
      titleAr: "سياسة ملفات تعريف الارتباط (Cookies)",
      contentHe:
        "האתר משתמש בקובצי Cookies לצורכי תפעול, אבטחה ושיפור חוויית משתמש. ניתן לנהל העדפות דרך הדפדפן.",
      contentAr:
        "يستخدم الموقع ملفات Cookies لأغراض التشغيل والأمان وتحسين تجربة المستخدم. يمكن إدارة التفضيلات من المتصفح.",
      isActive: true,
      sortOrder: 80,
    },
  ]);

  const layout = await HomeLayout.create({
    sections: [
      {
        id: "hero-1",
        type: "hero",
        enabled: true,
        order: 1,
        payload: {
          titleHe: STORE.brandDisplayHe,
          titleAr: STORE.brandDisplayAr,
          subtitleHe: "גילוח, תספורת וטיפוח מקצועי - במקום אחד",
          subtitleAr: "حلاقة، قص وتصفيف احترافي - في مكان واحد",
          ctaTextHe: "לחנות",
          ctaTextAr: "تسوق الآن",
          ctaLink: "/shop",
          videoUrl: "",
          videoPosterUrl: "",
        },
      },
      {
        id: "categories-1",
        type: "categories",
        enabled: true,
        order: 2,
        payload: {
          titleHe: "קטגוריות מובילות",
          titleAr: "أقسام مميزة",
        },
      },
      {
        id: "banner-1",
        type: "banner",
        enabled: true,
        order: 3,
        payload: {
          textHe: `משלוח חינם מעל 199₪ | תשלום במזומן (COD) | WhatsApp: ${STORE.whatsapp}`,
          textAr: `شحن مجاني فوق 199₪ | الدفع عند الاستلام | واتساب: ${STORE.whatsapp}`,
          link: "/shop",
        },
      },
      {
        id: "featured-products-1",
        type: "featured-products",
        enabled: true,
        order: 4,
        payload: {
          titleHe: "מוצרים מומלצים",
          titleAr: "منتجات مميزة",
          note: "Driven by ranking algorithm - no manual selection needed.",
        },
      },
    ],
  });

  console.log("✅ Settings, pages & layout created");
  return { settings, pages, layout };
}

async function createPromos(products, categories) {
  console.log("🏷️ Creating promos (coupons/campaigns/offers/gifts)...");

  const bySku = new Map(products.map((p) => [p.sku, p]));
  const catStyling = categories.find((c) => c.nameAr === CATEGORY_AR_BY_KEY[CATEGORY_KEY.STYLING_PRODUCTS]);
  const catFoil = categories.find((c) => c.nameAr === CATEGORY_AR_BY_KEY[CATEGORY_KEY.FOIL_SHAVERS]);

  const shampoo = bySku.get("PJ-ANTI-DANDRUFF-500ML");
  const booster = bySku.get("PJ-BOOSTER-MATTE-100G");
  const km1838 = bySku.get("KEM-KM1838-TRIM");

  const coupon = await Coupon.create({
    code: "WELCOME10",
    type: "percent",
    value: 10,
    minOrderTotal: 100,
    maxDiscount: 50,
    usageLimit: 500,
    usedCount: 0,
    reservedCount: 0,
    startAt: nowPlusDays(-2),
    endAt: nowPlusDays(60),
    isActive: true,
  });

  const campaign = catStyling
    ? await Campaign.create({
        nameHe: "מבצע מוצרי עיצוב - 15% הנחה",
        nameAr: "حملة منتجات التصفيف - خصم 15%",
        name: "Styling Products Sale - 15% Off",
        type: "percent",
        value: 15,
        appliesTo: "categories",
        productIds: [],
        categoryIds: [catStyling._id],
        priority: 50,
        stackable: true,
        startAt: nowPlusDays(-3),
        endAt: nowPlusDays(30),
        isActive: true,
      })
    : null;

  const offerFoilCategory = catFoil
    ? await Offer.create({
        nameHe: "10% הנחה על כל מכונות הפויל",
        nameAr: "خصم 10% على جميع ماكينات الفويل",
        name: "10% Off All Foil Shavers",
        type: "PERCENT_OFF",
        value: 10,
        minTotal: 0,
        productIds: [],
        categoryIds: [catFoil._id],
        priority: 100,
        stackable: true,
        startAt: nowPlusDays(-1),
        endAt: nowPlusDays(20),
        isActive: true,
      })
    : null;

  const offerFreeShipping = await Offer.create({
    nameHe: "משלוח חינם מעל 199₪",
    nameAr: "شحن مجاني للطلبات فوق 199₪",
    name: "Free shipping over 199 ILS",
    type: "FREE_SHIPPING",
    value: 0,
    minTotal: 199,
    productIds: [],
    categoryIds: [],
    priority: 90,
    stackable: true,
    startAt: nowPlusDays(-2),
    endAt: nowPlusDays(45),
    isActive: true,
  });

  const offerBuyXGetY =
    shampoo && booster
      ? await Offer.create({
          nameHe: "קנה שמפו וקבל Booster Wax במתנה",
          nameAr: "اشترِ شامبو واحصل على Booster Wax هدية",
          name: "Buy Anti-Dandruff Shampoo, Get Booster Wax Free",
          type: "BUY_X_GET_Y",
          value: 0,
          minTotal: 0,
          productIds: [],
          categoryIds: [],
          buyProductId: shampoo._id,
          buyVariantId: null,
          buyQty: 1,
          getProductId: booster._id,
          getVariantId: null,
          getQty: 1,
          maxDiscount: null,
          stackable: true,
          priority: 85,
          startAt: nowPlusDays(-1),
          endAt: nowPlusDays(25),
          isActive: true,
        })
      : null;

  let gift = null;
  if (km1838) {
    gift = await Gift.create({
      nameHe: "מתנה: Kemei KM-1838 בהזמנה מעל 350₪",
      nameAr: "هدية: Kemei KM-1838 عند طلب فوق 350₪",
      name: "Free KM-1838 Body Trimmer over 350 ILS",
      giftProductId: km1838._id,
      giftVariantId: null,
      qty: 1,
      minOrderTotal: 350,
      requiredProductId: null,
      requiredCategoryId: null,
      startAt: nowPlusDays(-1),
      endAt: nowPlusDays(30),
      isActive: true,
    });
  }

  console.log("✅ Promos created");
  return { coupon, campaign, offerFoilCategory, offerFreeShipping, offerBuyXGetY, gift };
}

async function runVerification() {
  const counts = {
    User: await User.countDocuments(),
    Category: await Category.countDocuments(),
    Product: await Product.countDocuments(),
    ProductAttribute: await ProductAttribute.countDocuments(),
    Order: await Order.countDocuments(),
    Coupon: await Coupon.countDocuments(),
    Campaign: await Campaign.countDocuments(),
    Offer: await Offer.countDocuments(),
    Gift: await Gift.countDocuments(),
    DeliveryArea: await DeliveryArea.countDocuments(),
    PickupPoint: await PickupPoint.countDocuments(),
    SiteSettings: await SiteSettings.countDocuments(),
    HomeLayout: await HomeLayout.countDocuments(),
    ContentPage: await ContentPage.countDocuments(),
    Review: await Review.countDocuments(),
    Counter: await Counter.countDocuments(),
    CouponRedemption: await CouponRedemption.countDocuments(),
    CouponUserUsage: await CouponUserUsage.countDocuments(),
  };

  console.log("  Created/updated counts:");
  Object.entries(counts).forEach(([name, n]) => console.log(`    ${name}: ${n}`));

  const orders = await Order.find().select("userId items").lean();
  const userIds = new Set((await User.find().select("_id").lean()).map((u) => u._id.toString()));
  const productIds = new Set((await Product.find().select("_id").lean()).map((p) => p._id.toString()));

  let refErrors = 0;
  for (const order of orders) {
    if (!order.userId || !userIds.has(order.userId.toString())) {
      console.warn(`  ⚠ Order ${order._id}: missing or invalid userId`);
      refErrors++;
    }
    for (const item of order.items || []) {
      if (!item.productId || !productIds.has(item.productId.toString())) {
        console.warn(`  ⚠ Order ${order._id} item: missing or invalid productId`);
        refErrors++;
      }
    }
  }
  if (refErrors === 0) {
    console.log("  ✅ No dangling references (orders → users, order items → products).");
  }
}

async function createRankingSignals(products) {
  const now = new Date();
  const signals = [];

  for (const p of products) {
    if (!p?.stats) continue;

    const productId = p._id;
    const stats = p.stats;

    const totalViews7d = Math.max(0, Number(stats.views7d || 0));
    const totalCartAdds30d = Math.max(0, Number(stats.cartAdds30d || 0));
    const totalWishlistAdds30d = Math.max(0, Number(stats.wishlistAdds30d || 0));
    const totalSoldCount30d = Math.max(0, Number(stats.soldCount30d || 0));

    if (totalViews7d === 0 && totalCartAdds30d === 0 && totalWishlistAdds30d === 0 && totalSoldCount30d === 0) {
      continue;
    }

    for (let daysAgo = 0; daysAgo < 30; daysAgo++) {
      const day = new Date(now);
      day.setDate(day.getDate() - daysAgo);
      day.setUTCHours(0, 0, 0, 0);

      const views = daysAgo < 7 ? Math.ceil(totalViews7d / 7) : 0;
      const addToCart = Math.ceil(totalCartAdds30d / 30);
      const wishlisted = Math.ceil(totalWishlistAdds30d / 30);
      const unitsSold = Math.ceil(totalSoldCount30d / 30);

      if (views > 0 || addToCart > 0 || wishlisted > 0 || unitsSold > 0) {
        signals.push({
          productId,
          day,
          views,
          addToCart,
          wishlisted,
          unitsSold,
          revenueMinor: unitsSold * toMinorSafe(p.price || 0),
        });
      }
    }
  }

  if (signals.length > 0) {
    await ProductSignalDaily.insertMany(signals, { ordered: false }).catch((err) => {
      if (err?.code !== 11000) throw err;
    });
    console.log(`✅ Created ${signals.length} ProductSignalDaily records`);
  }
}

async function createOrders(products, user, shipping, promos) {
  console.log("📦 Creating sample orders...");

  const bySku = new Map(products.map((p) => [p.sku, p]));
  const firstArea = (shipping?.areas ?? [])[0];

  const pShampoo = bySku.get("PJ-ANTI-DANDRUFF-500ML") || products[0];
  const pBooster = bySku.get("PJ-BOOSTER-MATTE-100G") || products[1];
  const pKM2026 = bySku.get("TXD-KM-2026") || products[2];
  const pKM1838 = bySku.get("KEM-KM1838-TRIM") || products[3];

  const year = new Date().getFullYear();
  await Counter.findOneAndUpdate(
    { key: "order", year },
    { $setOnInsert: { key: "order", year, seq: 0 } },
    { upsert: true }
  );

  const paidOrders = [];

  if (pShampoo) {
    const order1Subtotal = pShampoo.price * 2;
    const order1ShippingFee = 25;
    const order1Total = order1Subtotal + order1ShippingFee;

    paidOrders.push({
      userId: user._id,
      paymentMethod: "cod",
      orderNumber: await getNextOrderNumber(Counter),
      items: [
        {
          productId: pShampoo._id,
          titleHe: pShampoo.titleHe,
          titleAr: pShampoo.titleAr || "",
          title: pShampoo.titleHe,
          qty: 2,
          unitPrice: pShampoo.price,
          categoryId: pShampoo.categoryId,
          variantId: "",
          variantSnapshot: {},
        },
      ],
      pricing: buildOrderPricing({
        subtotal: order1Subtotal,
        shippingFee: order1ShippingFee,
        total: order1Total,
      }),
      shipping: buildOrderShipping({
        mode: "DELIVERY",
        phone: "0500000000",
        fullName: user.name,
        city: "Haifa",
        street: "Herzl 10",
        deliveryAreaId: firstArea?._id ?? null,
        deliveryAreaName: firstArea ? firstArea.nameHe || firstArea.name : "",
      }),
      status: "delivered",
      paidAt: new Date(),
      deliveredAt: new Date(),
    });
  }

  if (pKM2026 && pBooster) {
    const order2Subtotal = pKM2026.price + pBooster.price;
    const order2ShippingFee = 0;
    const order2Total = order2Subtotal + order2ShippingFee;

    paidOrders.push({
      userId: user._id,
      paymentMethod: "cod",
      orderNumber: await getNextOrderNumber(Counter),
      items: [
        {
          productId: pKM2026._id,
          titleHe: pKM2026.titleHe,
          titleAr: pKM2026.titleAr || "",
          title: pKM2026.titleHe,
          qty: 1,
          unitPrice: pKM2026.price,
          categoryId: pKM2026.categoryId,
          variantId: "",
          variantSnapshot: {},
        },
        {
          productId: pBooster._id,
          titleHe: pBooster.titleHe,
          titleAr: pBooster.titleAr || "",
          title: pBooster.titleHe,
          qty: 1,
          unitPrice: pBooster.price,
          categoryId: pBooster.categoryId,
          variantId: "",
          variantSnapshot: {},
        },
      ],
      pricing: buildOrderPricing({
        subtotal: order2Subtotal,
        shippingFee: order2ShippingFee,
        total: order2Total,
      }),
      shipping: buildOrderShipping({
        mode: "STORE_PICKUP",
        phone: STORE.phone.replace("+972", "0"),
        fullName: user.name,
      }),
      status: "delivered",
      paidAt: new Date(),
      deliveredAt: new Date(),
    });
  }

  for (const orderData of paidOrders) {
    await Order.create(orderData);
  }

  let order3Created = false;
  if (pKM1838 && pShampoo && promos?.coupon && promos?.campaign) {
    const subtotalRaw = pKM1838.price + pShampoo.price * 2;
    const campaignAmount = 0; // Shampoo in hair-care, campaign on styling
    const couponAmount = Math.min(
      Math.round((subtotalRaw * promos.coupon.value) / 100),
      promos.coupon.maxDiscount ?? 9999
    );
    const order3Subtotal = subtotalRaw;
    const order3ShippingFee = 30;
    const order3Total = order3Subtotal - campaignAmount - couponAmount + order3ShippingFee;

    const order3 = await Order.create({
      userId: user._id,
      paymentMethod: "cod",
      orderNumber: await getNextOrderNumber(Counter),
      items: [
        {
          productId: pKM1838._id,
          titleHe: pKM1838.titleHe,
          titleAr: pKM1838.titleAr || "",
          title: pKM1838.titleHe,
          qty: 1,
          unitPrice: pKM1838.price,
          categoryId: pKM1838.categoryId,
          variantId: "",
          variantSnapshot: {},
        },
        {
          productId: pShampoo._id,
          titleHe: pShampoo.titleHe,
          titleAr: pShampoo.titleAr || "",
          title: pShampoo.titleHe,
          qty: 2,
          unitPrice: pShampoo.price,
          categoryId: pShampoo.categoryId,
          variantId: "",
          variantSnapshot: {},
        },
      ],
      pricing: buildOrderPricing({
        subtotal: order3Subtotal,
        shippingFee: order3ShippingFee,
        total: Math.max(0, order3Total),
        couponCode: promos.coupon.code,
        couponAmount,
        campaignAmount,
        campaignId: promos.campaign?._id || null,
      }),
      shipping: buildOrderShipping({
        mode: "DELIVERY",
        phone: "0501111111",
        fullName: user.name,
        city: "Acre",
        street: "HaArbaa 24",
        deliveryAreaId: firstArea?._id ?? null,
        deliveryAreaName: firstArea ? firstArea.nameHe || firstArea.name : "",
      }),
      status: "delivered",
      paidAt: new Date(),
      deliveredAt: new Date(),
    });

    await CouponRedemption.create({
      couponId: promos.coupon._id,
      orderId: order3._id,
      userId: user._id,
      couponCode: promos.coupon.code,
      discountAmount: couponAmount,
      redeemedAt: new Date(),
    });

    await CouponUserUsage.findOneAndUpdate(
      { couponId: promos.coupon._id, userId: user._id },
      { $inc: { usedCount: 1 } },
      { upsert: true, setDefaultsOnInsert: true, new: true }
    );

    await Coupon.updateOne({ _id: promos.coupon._id }, { $inc: { usedCount: 1 } });

    order3Created = true;
  }

  const totalOrders = paidOrders.length + (order3Created ? 1 : 0);
  console.log(`✅ Created ${totalOrders} sample orders`);
}

async function main() {
  mustNotRunInProd();
  validateSeedEnv();

  await connectDB();

  try {
    await wipeDatabase();

    const { admin, staff, user } = await createUsers();
    await createProductAttributes();

    const categories = await createCategories();
    const products = await createProducts(categories);

    const shipping = await createShipping();
    await createSettings();
    const promos = await createPromos(products, categories);

    if (products?.length >= 3) {
      await Review.create([
        {
          productId: products[0]._id,
          userId: user._id,
          userName: user.name,
          rating: 5,
          comment: "מוצר מעולה! איכות גבוהה מאוד ושירות מהיר.",
          isHidden: false,
          moderationStatus: "approved",
          moderatedBy: admin._id,
          moderatedAt: new Date(),
        },
        {
          productId: products[2]._id,
          userId: user._id,
          userName: user.name,
          rating: 5,
          comment: "ممتاز جداً! جودة عالية وشحن سريع.",
          isHidden: false,
          moderationStatus: "approved",
          moderatedBy: staff._id,
          moderatedAt: new Date(),
        },
        {
          productId: products[7]._id,
          userId: user._id,
          userName: user.name,
          rating: 4,
          comment: "שמפו טוב נגד קשקשים, עובד מצוין!",
          isHidden: false,
          moderationStatus: "approved",
          moderatedBy: admin._id,
          moderatedAt: new Date(),
        },
      ]);
    }

    if (products?.length > 0 && user) {
      await createOrders(products, user, shipping, promos);
    }

    console.log("🔄 Creating ranking signal data...");
    await createRankingSignals(products);
    console.log("✅ Ranking signal data created");

    console.log("🔄 Recalculating ranking stats...");
    const { recalculateProductRanking } = await import("../services/ranking.service.js");
    await recalculateProductRanking();
    console.log("✅ Ranking stats updated");

    console.log("\n📋 Verification...");
    await runVerification();

    console.log("\n✅ SEED COMPLETED SUCCESSFULLY\n");
    console.log("📊 Database Summary:");
    console.log(`  👤 Users: 3 (Admin, Staff, Test User)`);
    console.log(`  📂 Categories: ${categories.length}`);
    console.log(`  🧴 Products: ${products.length} (verified set)`);
    console.log(`  🏷️  Promos: Multiple coupons, campaigns, offers & gifts`);
    console.log(`  🚚 Shipping: Delivery areas, pickup points & store pickup`);
    console.log(`  📦 Orders: Sample orders with COD payments`);
    console.log(`  ⭐ Reviews: Sample product reviews`);
    console.log("\n🔐 Accounts created (emails only):");
    console.log(`  Admin: ${String(process.env.SEED_ADMIN_EMAIL || "").trim().toLowerCase()}`);
    console.log(`  Staff: ${String(process.env.SEED_STAFF_EMAIL || "").trim().toLowerCase()}`);
    console.log(`  Test:  ${String(process.env.SEED_TEST_EMAIL || "").trim().toLowerCase()}`);
    console.log("\n📝 Notes:");
    console.log("  ✅ KM-1735 confirmed by packaging (Fade/Grading, 2 color variants)");
    console.log("  ✅ KM-1808 confirmed as Professional Hair Trimmer (from packaging photos)");
    console.log("  ✅ KM-1867 supplier spec provided (until packaging documentation)");
    console.log("  ✅ KM-1868 corrected to Hair Clipper/Trimmer (confirmed from packaging)");
    console.log("  ✅ Unified store identity across shipping/settings/content");
  } catch (e) {
    console.error("❌ Seed failed:", e);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main();
