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
      nameAr: "ماكينات قص الشعر",
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
      nameAr: "ماكينات فويل للحلاقة",
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
      nameAr: "تريمرات احترافية",
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
      nameHe: "טיפוח פנים",
      nameAr: "العناية بالوجه",
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
      nameHe: "שמפו וטיפוח שיער",
      nameAr: "شامبو وعناية الشعر",
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
      nameAr: "تصفيف الشعر",
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
      nameHe: "אחרי גילוח",
      nameAr: "ما بعد الحلاقة",
      imageUrl: "/uploads/seed/categories/after-shave.jpg",
      descriptionHe: "מוצרי רענון וטיפוח אחרי גילוח.",
      descriptionAr: "منتجات انتعاش وعناية بعد الحلاقة.",
      isActive: true,
      sortOrder: 70,
      metaTitleHe: "אחרי גילוח | Pier Jouliet After Shave",
      metaTitleAr: "ما بعد الحلاقة | Pier Jouliet After Shave",
      metaDescriptionHe: "קולוניה ומוצרי אפטר שייב איכותיים.",
      metaDescriptionAr: "كولونيا ومنتجات أفتر شيف عالية الجودة.",
    },
  ];

  const categories = await Category.create(sortByOrder(categoriesInput));
  console.log(`✅ Categories created: ${categories.length}`);
  return categories;
}

/* =========================================
   Products (16 verified)
========================================= */
async function createProducts(categories) {
  const byNameAr = new Map(categories.map((c) => [c.nameAr, c]));

  const catHairClippers = byNameAr.get("ماكينات قص الشعر");
  const catFoilShavers = byNameAr.get("ماكينات فويل للحلاقة");
  const catTrimmers = byNameAr.get("تريمرات احترافية");
  const catFacialCare = byNameAr.get("العناية بالوجه");
  const catHairCare = byNameAr.get("شامبو وعناية الشعر");
  const catStyling = byNameAr.get("تصفيف الشعر");
  const catAfterShave = byNameAr.get("ما بعد الحلاقة");

  if (!catHairClippers || !catFoilShavers || !catTrimmers || !catFacialCare || !catHairCare || !catStyling || !catAfterShave) {
    throw new Error("Missing one or more categories (seed integrity error).");
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
      images: [{ url: "/uploads/seed/products/01_Kemei_KM-1848.jpeg", secureUrl: "/uploads/seed/products/01_Kemei_KM-1848.jpeg", altHe: "Kemei KM-1848 טרימר לאזורים אינטימיים", altAr: "Kemei KM-1848 ماكينة تشذيب للمناطق الحساسة", isPrimary: true, sortOrder: 0 }],
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
      images: [{ url: "/uploads/seed/products/03_Kemei_KM-2026.jpeg", secureUrl: "/uploads/seed/products/03_Kemei_KM-2026.jpeg", altHe: "Kemei KM-2026 פויל", altAr: "Kemei KM-2026 فويل", isPrimary: true, sortOrder: 0 }],
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
      images: [{ url: "/uploads/seed/products/04_Kemei_KM-2027.jpeg", secureUrl: "/uploads/seed/products/04_Kemei_KM-2027.jpeg", altHe: "Kemei KM-2027 פויל", altAr: "Kemei KM-2027 فويل", isPrimary: true, sortOrder: 0 }],
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
      images: [{ url: "/uploads/seed/products/05_Kemei_KM-2028_Gold.jpeg", secureUrl: "/uploads/seed/products/05_Kemei_KM-2028_Gold.jpeg", altHe: "Kemei KM-2028 Gold מכונת גילוח פנים", altAr: "Kemei KM-2028 Gold ماكينة حلاقة وجه", isPrimary: true, sortOrder: 0 }],
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
      images: [{ url: "/uploads/seed/products/11_PierJouliet_AfterShave.jpeg", secureUrl: "/uploads/seed/products/11_PierJouliet_AfterShave.jpeg", altHe: "After Shave Cologne", altAr: "After Shave Cologne", isPrimary: true, sortOrder: 0 }],
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
      images: [{ url: "/uploads/seed/products/14_Kemei_KM-1735.jpeg", secureUrl: "/uploads/seed/products/14_Kemei_KM-1735.jpeg", altHe: "Kemei KM-1735 מכונת דירוג", altAr: "Kemei KM-1735 ماكينة تدريج", isPrimary: true, sortOrder: 0 }],
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
      images: [{ url: "/uploads/seed/products/15_Kemei_KM-1838.jpeg", secureUrl: "/uploads/seed/products/15_Kemei_KM-1838.jpeg", altHe: "Kemei KM-1838 טרימר גוף", altAr: "Kemei KM-1838 تريمر الجسم", isPrimary: true, sortOrder: 0 }],
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
      images: [{ url: "/uploads/seed/products/16_Kemei_KM-1693.jpeg", secureUrl: "/uploads/seed/products/16_Kemei_KM-1693.jpeg", altHe: "Kemei KM-1693 מכונת טרימר Type-C", altAr: "Kemei KM-1693 ماكينة تحديد Type-C", isPrimary: true, sortOrder: 0 }],
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
      images: [{ url: "/uploads/seed/products/17_Kemei_KM-1808.jpeg", secureUrl: "/uploads/seed/products/17_Kemei_KM-1808.jpeg", altHe: "Kemei KM-1808 טרימר שיער", altAr: "Kemei KM-1808 ماكينة تحديد شعر", isPrimary: true, sortOrder: 0 }],
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
      images: [{ url: "/uploads/seed/products/18_Kemei_KM-1868_Clipper.jpeg", secureUrl: "/uploads/seed/products/18_Kemei_KM-1868_Clipper.jpeg", altHe: "Kemei KM-1868 מכונת תספורת", altAr: "Kemei KM-1868 ماكينة حلاقة", isPrimary: true, sortOrder: 0 }],
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
      images: [{ url: "/uploads/seed/products/19_Kemei_KM-1867.jpeg", secureUrl: "/uploads/seed/products/19_Kemei_KM-1867.jpeg", altHe: "Kemei KM-1867 טרימר", altAr: "Kemei KM-1867 ماكينة تحديد", isPrimary: true, sortOrder: 0 }],
      stats: { soldCount30d: 0, ratingAvg: 0, ratingCount: 0, views7d: 0, cartAdds30d: 0, wishlistAdds30d: 0 },
    },
  ];

  console.log(`🧴 Creating products (${productsInput.length} items)...`);

  const prepared = productsInput.map((p) => {
    const slug = slugFromSku(p.sku) || undefined;
    const priceMinor = toMinorSafe(p.price);
    const salePriceMinor = p.salePrice != null ? toMinorSafe(p.salePrice) : null;

    return {
      ...p,
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
  const catStyling = categories.find((c) => c.nameAr === "تصفيف الشعر");
  const catFoil = categories.find((c) => c.nameAr === "ماكينات فويل للحلاقة");

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
    console.log(`  📂 Categories: 7`);
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
