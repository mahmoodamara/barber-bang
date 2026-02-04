// scripts/seed.js
// ✅ FULL Production-grade Seeder for this server (ESM)
// - Refuses to run in production unless ALLOW_SEED_PROD=true
// - Deletes ALL existing data first (in safe order)
// - Seeds Admin/Staff/User + Attributes + Categories + Products + Shipping + Promos + Settings + HomeLayout + Content Pages
// - Compatible with CURRENT models (bilingual he/ar + product stats + offer schema)

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

async function wipeDatabase() {
  console.log("🧹 WIPING DATABASE...");

  // Order matters (avoid reference/logic constraints in services)
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

  const adminEmail = String(process.env.SEED_ADMIN_EMAIL).trim().toLowerCase();
  const staffEmail = String(process.env.SEED_STAFF_EMAIL).trim().toLowerCase();
  const testEmail = String(process.env.SEED_TEST_EMAIL).trim().toLowerCase();

  const adminPassword = String(process.env.SEED_ADMIN_PASSWORD);
  const staffPassword = String(process.env.SEED_STAFF_PASSWORD);
  const testPassword = String(process.env.SEED_TEST_PASSWORD);

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

async function createProductAttributes() {
  console.log("🏷️ Creating product attributes...");

  const attrs = await ProductAttribute.create([
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
        { valueKey: "citrus", labelHe: "הדרים", labelAr: "حمضيات", isActive: true },
        { valueKey: "woody", labelHe: "עציי", labelAr: "خشبي", isActive: true },
        { valueKey: "unscented", labelHe: "ללא ריח", labelAr: "بدون رائحة", isActive: true },
      ],
      isActive: true,
    },
    {
      key: "volume_ml",
      nameHe: "נפח (מ״ל)",
      nameAr: "الحجم (مل)",
      type: "number",
      unit: "ml",
      options: [],
      isActive: true,
    },
  ]);

  console.log(`✅ Product attributes created: ${attrs.length}`);
  return attrs;
}

async function createCategories() {
  console.log("📚 Creating categories...");

  const categories = await Category.create([
    {
      nameHe: "עיצוב שיער",
      nameAr: "تصفيف الشعر",
      imageUrl:
        "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=1200&auto=format&fit=crop",
      descriptionHe: "פומדות, ווקסים, חימר ומוצרים מקצועיים לעיצוב.",
      descriptionAr: "بوميد، واكس، كلاي ومنتجات احترافية للتصفيف.",
      isActive: true,
      sortOrder: 10,
      metaTitleHe: "עיצוב שיער מקצועי",
      metaTitleAr: "تصفيف شعر احترافي",
      metaDescriptionHe: "מבחר מוצרי עיצוב שיער לגברים.",
      metaDescriptionAr: "تشكيلة منتجات تصفيف شعر للرجال.",
    },
    {
      nameHe: "טיפוח זקן",
      nameAr: "العناية باللحية",
      imageUrl:
        "https://images.unsplash.com/photo-1520975916090-3105956dac38?w=1200&auto=format&fit=crop",
      descriptionHe: "שמנים, באלמים ומסכות לזקן.",
      descriptionAr: "زيوت، بلسم، وماسكات للعناية باللحية.",
      isActive: true,
      sortOrder: 20,
    },
    {
      nameHe: "גילוח",
      nameAr: "الحلاقة",
      imageUrl:
        "https://images.unsplash.com/photo-1611078489935-0cb964de46d0?w=1200&auto=format&fit=crop",
      descriptionHe: "סכינים, קצף/ג׳ל, אחרי גילוח.",
      descriptionAr: "شفرات، رغوة/جل، وبعد الحلاقة.",
      isActive: true,
      sortOrder: 30,
    },
    {
      nameHe: "כלים ואביזרים",
      nameAr: "أدوات وإكسسوارات",
      imageUrl:
        "https://images.unsplash.com/photo-1516478177764-9fe5bd7e9717?w=1200&auto=format&fit=crop",
      descriptionHe: "מברשות, מסרקים, מספריים ועוד.",
      descriptionAr: "فرش، أمشاط، مقصات والمزيد.",
      isActive: true,
      sortOrder: 40,
    },
    {
      nameHe: "שמפו וטיפוח",
      nameAr: "شامبو وعناية",
      imageUrl:
        "https://images.unsplash.com/photo-1526948128573-703ee1aeb6fa?w=1200&auto=format&fit=crop",
      descriptionHe: "שמפו, מרכך, מסכות לשיער.",
      descriptionAr: "شامبو، بلسم، ماسكات للشعر.",
      isActive: true,
      sortOrder: 50,
    },
  ]);

  console.log(`✅ Categories created: ${categories.length}`);
  return categories;
}

async function createProducts(categories) {
  console.log("🧴 Creating products...");

  const byNameHe = new Map(categories.map((c) => [c.nameHe, c]));

  const catHair = byNameHe.get("עיצוב שיער");
  const catBeard = byNameHe.get("טיפוח זקן");
  const catShave = byNameHe.get("גילוח");
  const catTools = byNameHe.get("כלים ואביזרים");
  const catCare = byNameHe.get("שמפו וטיפוח");

  if (!catHair || !catBeard || !catShave || !catTools || !catCare) {
    throw new Error("Missing one or more categories (seed integrity error).");
  }

  const productsInput = [
    {
      titleHe: "פומדה חזקה – גימור טבעי",
      titleAr: "بوميد قوي – لمسة طبيعية",
      descriptionHe: "פומדה מקצועית לאחיזה חזקה עם גימור טבעי. מתאימה לכל סוגי השיער.",
      descriptionAr: "بوميد احترافي بتثبيت قوي ولمسة طبيعية. مناسب لجميع أنواع الشعر.",
      price: 59.9,
      salePrice: 49.9,
      saleStartAt: nowPlusDays(-2),
      saleEndAt: nowPlusDays(10),
      stock: 120,
      categoryId: catHair._id,
      brand: "GroomMaster",
      sku: "GM-POMADE-STRONG",
      tags: ["pomade", "hair", "styling"],
      images: [
        {
          url: "https://images.unsplash.com/photo-1595476108010-b4d1f102b1b1?w=1200&auto=format&fit=crop",
          secureUrl:
            "https://images.unsplash.com/photo-1595476108010-b4d1f102b1b1?w=1200&auto=format&fit=crop",
          altHe: "פומדה לעיצוב שיער",
          altAr: "بوميد لتصفيف الشعر",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: {
        soldCount30d: 48,
        ratingAvg: 4.8,
        ratingCount: 33,
        views7d: 320,
        cartAdds30d: 80,
        wishlistAdds30d: 45,
      },
    },
    {
      titleHe: "ווקס מט – אחיזה בינונית",
      titleAr: "واكس مطفي – تثبيت متوسط",
      descriptionHe: "ווקס מט עם אחיזה בינונית, קל לשטיפה ומתאים ליום יום.",
      descriptionAr: "واكس مطفي بتثبيت متوسط، سهل الغسل ومناسب للاستخدام اليومي.",
      price: 54.9,
      stock: 90,
      categoryId: catHair._id,
      brand: "SharpMan",
      sku: "SM-WAX-MATTE",
      tags: ["wax", "matte", "styling"],
      images: [
        {
          url: "https://images.unsplash.com/photo-1621600411688-4be93cd68504?w=1200&auto=format&fit=crop",
          secureUrl:
            "https://images.unsplash.com/photo-1621600411688-4be93cd68504?w=1200&auto=format&fit=crop",
          altHe: "ווקס מט לשיער",
          altAr: "واكس مطفي للشعر",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: {
        soldCount30d: 22,
        ratingAvg: 4.4,
        ratingCount: 17,
        views7d: 210,
        cartAdds30d: 55,
        wishlistAdds30d: 18,
      },
    },
    {
      titleHe: "שמן זקן פרימיום – ריח הדרים",
      titleAr: "زيت لحية بريميوم – رائحة حمضيات",
      descriptionHe: "שמן זקן מזין, מרכך ומוסיף ברק טבעי. מתאים לשימוש יומי.",
      descriptionAr: "زيت لحية مغذّي، ينعّم ويمنح لمعان طبيعي. مناسب للاستخدام اليومي.",
      price: 69.9,
      stock: 70,
      categoryId: catBeard._id,
      brand: "BarberZone",
      sku: "BZ-BEARD-OIL-CITRUS",
      tags: ["beard", "oil", "care"],
      images: [
        {
          url: "https://images.unsplash.com/photo-1585232351009-aa87416fca90?w=1200&auto=format&fit=crop",
          secureUrl:
            "https://images.unsplash.com/photo-1585232351009-aa87416fca90?w=1200&auto=format&fit=crop",
          altHe: "שמן זקן הדרים",
          altAr: "زيت لحية حمضيات",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: {
        soldCount30d: 30,
        ratingAvg: 4.7,
        ratingCount: 24,
        views7d: 260,
        cartAdds30d: 63,
        wishlistAdds30d: 29,
      },
    },
    {
      titleHe: "באלם זקן – ללא ריח",
      titleAr: "بلسم لحية – بدون رائحة",
      descriptionHe: "באלם מרכך, מסדר ומעניק מראה מסודר בלי ריח.",
      descriptionAr: "بلسم ينعّم ويرتب اللحية ويمنح مظهر مرتب بدون رائحة.",
      price: 64.9,
      stock: 60,
      categoryId: catBeard._id,
      brand: "GroomMaster",
      sku: "GM-BEARD-BALM-UNSCENTED",
      tags: ["beard", "balm"],
      images: [
        {
          url: "https://images.unsplash.com/photo-1631730486572-226d1f74b4fd?w=1200&auto=format&fit=crop",
          secureUrl:
            "https://images.unsplash.com/photo-1631730486572-226d1f74b4fd?w=1200&auto=format&fit=crop",
          altHe: "באלם זקן ללא ריח",
          altAr: "بلسم لحية بدون رائحة",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: {
        soldCount30d: 14,
        ratingAvg: 4.3,
        ratingCount: 9,
        views7d: 120,
        cartAdds30d: 31,
        wishlistAdds30d: 11,
      },
    },
    {
      titleHe: "ג׳ל גילוח שקוף",
      titleAr: "جل حلاقة شفاف",
      descriptionHe: "ג׳ל שקוף לגילוח מדויק, מפחית גירויים ומרכך את העור.",
      descriptionAr: "جل شفاف لحلاقة دقيقة، يقلل التهيج ويرطب البشرة.",
      price: 39.9,
      stock: 100,
      categoryId: catShave._id,
      brand: "SharpMan",
      sku: "SM-SHAVE-GEL-CLEAR",
      tags: ["shaving", "gel"],
      images: [
        {
          url: "https://images.unsplash.com/photo-1621607512020-6c0f8a3a8a6b?w=1200&auto=format&fit=crop",
          secureUrl:
            "https://images.unsplash.com/photo-1621607512020-6c0f8a3a8a6b?w=1200&auto=format&fit=crop",
          altHe: "ג׳ל גילוח",
          altAr: "جل حلاقة",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: {
        soldCount30d: 10,
        ratingAvg: 4.2,
        ratingCount: 6,
        views7d: 90,
        cartAdds30d: 20,
        wishlistAdds30d: 7,
      },
    },
    {
      titleHe: "אחרי גילוח – רענן",
      titleAr: "بعد الحلاقة – منعش",
      descriptionHe: "תחושת רעננות מיידית אחרי גילוח, מתאים לעור רגיש.",
      descriptionAr: "انتعاش فوري بعد الحلاقة، مناسب للبشرة الحساسة.",
      price: 44.9,
      stock: 80,
      categoryId: catShave._id,
      brand: "BarberZone",
      sku: "BZ-AFTERSHAVE-FRESH",
      tags: ["shaving", "aftershave"],
      images: [
        {
          url: "https://images.unsplash.com/photo-1621600263707-1b78b26b984d?w=1200&auto=format&fit=crop",
          secureUrl:
            "https://images.unsplash.com/photo-1621600263707-1b78b26b984d?w=1200&auto=format&fit=crop",
          altHe: "אחרי גילוח רענן",
          altAr: "بعد الحلاقة منعش",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: {
        soldCount30d: 16,
        ratingAvg: 4.5,
        ratingCount: 12,
        views7d: 140,
        cartAdds30d: 28,
        wishlistAdds30d: 15,
      },
    },
    {
      titleHe: "מסרק קלאסי – אנטי סטטי",
      titleAr: "مشط كلاسيكي – مضاد للكهرباء",
      descriptionHe: "מסרק מקצועי נגד חשמל סטטי, מתאים לגברים ולעיצוב מדויק.",
      descriptionAr: "مشط احترافي ضد الكهرباء الساكنة، مناسب لتصفيف دقيق.",
      price: 19.9,
      stock: 200,
      categoryId: catTools._id,
      brand: "GroomMaster",
      sku: "GM-COMB-CLASSIC",
      tags: ["tools", "comb"],
      images: [
        {
          url: "https://images.unsplash.com/photo-1526045478516-99145907023c?w=1200&auto=format&fit=crop",
          secureUrl:
            "https://images.unsplash.com/photo-1526045478516-99145907023c?w=1200&auto=format&fit=crop",
          altHe: "מסרק קלאסי",
          altAr: "مشط كلاسيكي",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: {
        soldCount30d: 40,
        ratingAvg: 4.6,
        ratingCount: 19,
        views7d: 180,
        cartAdds30d: 44,
        wishlistAdds30d: 21,
      },
    },
    {
      titleHe: "מברשת זקן מקצועית",
      titleAr: "فرشاة لحية احترافية",
      descriptionHe: "מברשת זקן לשימוש יום-יומי לסידור וניקוי.",
      descriptionAr: "فرشاة لحية للاستخدام اليومي للترتيب والتنظيف.",
      price: 29.9,
      stock: 150,
      categoryId: catTools._id,
      brand: "SharpMan",
      sku: "SM-BEARD-BRUSH",
      tags: ["tools", "beard"],
      images: [
        {
          url: "https://images.unsplash.com/photo-1520975958225-4b4b21a86c0c?w=1200&auto=format&fit=crop",
          secureUrl:
            "https://images.unsplash.com/photo-1520975958225-4b4b21a86c0c?w=1200&auto=format&fit=crop",
          altHe: "מברשת זקן",
          altAr: "فرشاة لحية",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: {
        soldCount30d: 26,
        ratingAvg: 4.4,
        ratingCount: 8,
        views7d: 110,
        cartAdds30d: 25,
        wishlistAdds30d: 9,
      },
    },
    {
      titleHe: "שמפו יומיומי – לשיער רגיל",
      titleAr: "شامبو يومي – للشعر العادي",
      descriptionHe: "שמפו עדין לשימוש יומי, מנקה ומאזן את הקרקפת.",
      descriptionAr: "شامبو لطيف للاستخدام اليومي، ينظف ويوازن فروة الرأس.",
      price: 34.9,
      stock: 110,
      categoryId: catCare._id,
      brand: "BarberZone",
      sku: "BZ-SHAMPOO-DAILY",
      tags: ["care", "shampoo"],
      images: [
        {
          url: "https://images.unsplash.com/photo-1585232351171-05d3fbcd1a74?w=1200&auto=format&fit=crop",
          secureUrl:
            "https://images.unsplash.com/photo-1585232351171-05d3fbcd1a74?w=1200&auto=format&fit=crop",
          altHe: "שמפו יומיומי",
          altAr: "شامبو يومي",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: {
        soldCount30d: 12,
        ratingAvg: 4.1,
        ratingCount: 7,
        views7d: 95,
        cartAdds30d: 21,
        wishlistAdds30d: 6,
      },
    },
    {
      titleHe: "מרכך לשיער – לחות",
      titleAr: "بلسم شعر – ترطيب",
      descriptionHe: "מרכך עשיר בלחות לשיער רך ונעים לאורך היום.",
      descriptionAr: "بلسم غني بالترطيب لشعر ناعم ومريح طوال اليوم.",
      price: 36.9,
      stock: 95,
      categoryId: catCare._id,
      brand: "GroomMaster",
      sku: "GM-CONDITIONER-HYDRATE",
      tags: ["care", "conditioner"],
      images: [
        {
          url: "https://images.unsplash.com/photo-1620917669788-be691f1551f5?w=1200&auto=format&fit=crop",
          secureUrl:
            "https://images.unsplash.com/photo-1620917669788-be691f1551f5?w=1200&auto=format&fit=crop",
          altHe: "מרכך לחות",
          altAr: "بلسم ترطيب",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: {
        soldCount30d: 9,
        ratingAvg: 4.0,
        ratingCount: 5,
        views7d: 70,
        cartAdds30d: 18,
        wishlistAdds30d: 5,
      },
    },
    // Product with variants (for BUY_X_GET_Y and variant gift)
    {
      titleHe: "שמן זקן – מגוון ריחות",
      titleAr: "زيت لحية – تشكيلة روائح",
      descriptionHe: "שמן זקן באריזה אחידה, לבחירת ריח: רענן או הדרים.",
      descriptionAr: "زيت لحية بعبوة موحدة، اختيار الرائحة: منعش أو حمضيات.",
      price: 65,
      stock: 0,
      categoryId: catBeard._id,
      brand: "BarberZone",
      sku: "BZ-BEARD-OIL-VAR",
      tags: ["beard", "oil", "variants"],
      images: [
        {
          url: "https://images.unsplash.com/photo-1585232351009-aa87416fca90?w=1200&auto=format&fit=crop",
          secureUrl:
            "https://images.unsplash.com/photo-1585232351009-aa87416fca90?w=1200&auto=format&fit=crop",
          altHe: "שמן זקן מגוון",
          altAr: "زيت لحية تشكيلة",
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      stats: {
        soldCount30d: 12,
        ratingAvg: 4.5,
        ratingCount: 8,
        views7d: 90,
        cartAdds30d: 22,
        wishlistAdds30d: 10,
      },
      variants: [
        {
          sku: "BZ-BEARD-OIL-VAR-FRESH",
          stock: 40,
          attributes: [
            { key: "scent", type: "enum", valueKey: "fresh", value: "fresh", unit: "" },
          ],
        },
        {
          sku: "BZ-BEARD-OIL-VAR-CITRUS",
          stock: 35,
          attributes: [
            { key: "scent", type: "enum", valueKey: "citrus", value: "citrus", unit: "" },
          ],
        },
      ],
    },
  ];

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
      discountPercent: null, // computed by backend logic if needed
    };
  });

  // Use create() (not insertMany) to run schema validations/hooks consistently.
  const created = await Product.create(prepared);

  console.log(`✅ Products created: ${created.length}`);
  return created;
}

async function createShipping() {
  console.log("🚚 Creating shipping config...");

  const [areas, points, storePickup] = await Promise.all([
    DeliveryArea.create([
      { nameHe: "עכו", nameAr: "عكا", fee: 25, isActive: true },
      { nameHe: "חיפה", nameAr: "حيفا", fee: 30, isActive: true },
      { nameHe: "נהריה", nameAr: "نهاريا", fee: 30, isActive: true },
      { nameHe: "כרמיאל", nameAr: "كرميئيل", fee: 35, isActive: true },
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
        nameHe: "נקודת איסוף - חיפה",
        nameAr: "نقطة استلام - حيفا",
        addressHe: "חיפה, מרכז הכרמל",
        addressAr: "حيفا, مركز الكرمل",
        fee: 12,
        isActive: true,
      },
    ]),
    StorePickupConfig.create({
      isEnabled: true,
      fee: 0,
      addressHe: "עכו, דרך הארבעה 24",
      addressAr: "عكا, طريق الأربعة 24",
      notesHe: "איסוף מהחנות בתיאום מראש.",
      notesAr: "استلام من المتجر بعد التنسيق مسبقًا.",
      address: "Acre, Derech HaArbaa 24",
      notes: "Store pickup by appointment.",
    }),
  ]);

  console.log("✅ Shipping config created");
  return { areas, points, storePickup };
}

async function createSettings() {
  console.log("⚙️ Creating SiteSettings + HomeLayout + Content pages...");

  const settings = await SiteSettings.create({
    storeNameHe: "Barber Store",
    storeNameAr: "متجر الحلاق",
    logoUrl: "",
    faviconUrl: "",
    whatsappNumber: "+972545983684",
    phone: "+972545983684",
    email: "support@shop.local",
    addressHe: "עכו, דרך הארבעה 24",
    addressAr: "عكا, طريق الأربعة 24",
    businessHoursHe: "א-ה 10:00-20:00",
    businessHoursAr: "الأحد-الخميس 10:00-20:00",
    socialLinks: {
      instagram: "",
      facebook: "",
      tiktok: "",
    },
    topBar: {
      enabled: true,
      textHe: "משלוח מהיר לכל הארץ",
      textAr: "شحن سريع لجميع المناطق",
      link: "/shop",
    },
    seoDefaults: {
      titleHe: "Barber Store | מוצרי טיפוח לגברים",
      titleAr: "Barber Store | منتجات عناية للرجال",
      descriptionHe: "מוצרי שיער, זקן וגילוח ברמה מקצועית.",
      descriptionAr: "منتجات شعر ولحية وحلاقة بمستوى احترافي.",
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

  // IMPORTANT: match frontend links like /content/:slug
  const pages = await ContentPage.create([
    {
      slug: "about",
      titleHe: "אודות",
      titleAr: "من نحن",
      contentHe:
        "ברוכים הבאים ל-Barber Store. אנחנו מתמחים במוצרי טיפוח לגברים ברמה מקצועית.",
      contentAr:
        "مرحبًا بك في Barber Store. نحن متخصصون في منتجات العناية للرجال بمستوى احترافي.",
      isActive: true,
      sortOrder: 10,
    },
    {
      slug: "accessibility",
      titleHe: "נגישות",
      titleAr: "إمكانية الوصول",
      contentHe:
        "אנחנו מחויבים לספק חווית גלישה נגישה לכולם. אם נתקלתם בבעיה – צרו קשר.",
      contentAr:
        "نحن ملتزمون بتوفير تجربة تصفح مريحة للجميع. إذا واجهت مشكلة تواصل معنا.",
      isActive: true,
      sortOrder: 20,
    },
    {
      slug: "shipping",
      titleHe: "משלוחים",
      titleAr: "الشحن",
      contentHe:
        "זמני שילוח משתנים לפי אזור. ניתן לבחור איסוף עצמי / נקודת איסוף / משלוח עד הבית.",
      contentAr:
        "تختلف أوقات الشحن حسب المنطقة. يمكنك اختيار استلام من المتجر / نقطة استلام / توصيل للمنزل.",
      isActive: true,
      sortOrder: 30,
    },
    {
      slug: "returns",
      titleHe: "החזרות",
      titleAr: "الإرجاع",
      contentHe: "ניתן להגיש בקשת החזרה מתוך ההזמנה. המוצר חייב להיות במצב חדש.",
      contentAr: "يمكن تقديم طلب إرجاع من داخل الطلب. يجب أن يكون المنتج بحالة جديدة.",
      isActive: true,
      sortOrder: 40,
    },
    {
      slug: "terms",
      titleHe: "תנאי שימוש",
      titleAr: "شروط الاستخدام",
      contentHe: "השימוש באתר כפוף לתנאים המפורטים בעמוד זה.",
      contentAr: "استخدام الموقع يخضع للشروط الموضحة في هذه الصفحة.",
      isActive: true,
      sortOrder: 50,
    },
    {
      slug: "privacy",
      titleHe: "מדיניות פרטיות",
      titleAr: "سياسة الخصوصية",
      contentHe: "אנו מכבדים את פרטיותכם ושומרים על המידע בהתאם למדיניות זו.",
      contentAr: "نحترم خصوصيتك ونحافظ على بياناتك وفقًا لهذه السياسة.",
      isActive: true,
      sortOrder: 60,
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
          titleHe: "מוצרים לגבר המודרני",
          titleAr: "منتجات للرجل العصري",
          subtitleHe: "סטייל, זקן וגילוח — ברמה מקצועית",
          subtitleAr: "تصفيف، لحية وحلاقة — بمستوى احترافي",
          ctaTextHe: "קנייה עכשיו",
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
          textHe: "משלוח מהיר + תשלום במזומן (COD)",
          textAr: "شحن سريع + الدفع عند الاستلام",
          link: "/checkout",
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
          note: "Featured products can be driven by ranking endpoints (NO MANUAL FLAGS).",
        },
      },
    ],
  });

  console.log("✅ Settings created");
  return { settings, pages, layout };
}

async function createPromos(products, categories) {
  console.log("🏷️ Creating promos (coupons/campaigns/offers/gifts)...");

  const firstProduct = products?.[0];
  const secondProduct = products?.[1];
  const catHair = categories.find((c) => c.nameHe === "עיצוב שיער");

  const coupon = await Coupon.create({
    code: "WELCOME10",
    type: "percent",
    value: 10,
    minOrderTotal: 100,
    maxDiscount: 50,
    usageLimit: 500,
    usedCount: 0,
    reservedCount: 0,
    startAt: nowPlusDays(-1),
    endAt: nowPlusDays(60),
    isActive: true,
  });

  const campaign = await Campaign.create({
    nameHe: "מבצע עיצוב שיער",
    nameAr: "حملة تصفيف الشعر",
    // legacy will be auto-synced if empty, but we set it anyway
    name: "Hair Styling Campaign",
    type: "percent",
    value: 8,
    appliesTo: "categories",
    productIds: [],
    categoryIds: catHair ? [catHair._id] : [],
    priority: 50,
    stackable: true,
    startAt: nowPlusDays(-2),
    endAt: nowPlusDays(30),
    isActive: true,
  });

  // ✅ Offer schema FIX: remove buyX/getY (NOT in model)
  // Keep it simple + compatible: one percent-off on a product + one free-shipping offer.
  const offerPercent = await Offer.create({
    nameHe: "10% הנחה על מוצר נבחר",
    nameAr: "خصم 10% على منتج محدد",
    name: "10% Off Selected Product",
    type: "PERCENT_OFF",
    value: 10,
    minTotal: 0,
    productIds: secondProduct ? [secondProduct._id] : [],
    categoryIds: [],
    priority: 100,
    stackable: true,
    startAt: nowPlusDays(-1),
    endAt: nowPlusDays(15),
    isActive: true,
  });

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
    startAt: nowPlusDays(-1),
    endAt: nowPlusDays(30),
    isActive: true,
  });

  // BUY_X_GET_Y: buy first product (pomade), get second (wax) free
  const offerBuyXGetY =
    firstProduct && secondProduct
      ? await Offer.create({
          nameHe: "קנה פומדה קבל ווקס במתנה",
          nameAr: "اشتري بوميد واحصل على واكس هدية",
          name: "Buy Pomade Get Wax",
          type: "BUY_X_GET_Y",
          value: 0,
          minTotal: 0,
          productIds: [],
          categoryIds: [],
          buyProductId: firstProduct._id,
          buyVariantId: null,
          buyQty: 1,
          getProductId: secondProduct._id,
          getVariantId: null,
          getQty: 1,
          maxDiscount: null,
          stackable: true,
          priority: 85,
          startAt: nowPlusDays(-1),
          endAt: nowPlusDays(30),
          isActive: true,
        })
      : null;

  // Gift: free sample for orders above 199₪ (qty 1; no variant)
  let gift = null;
  if (firstProduct) {
    gift = await Gift.create({
      nameHe: "מתנה בהזמנה מעל 199₪",
      nameAr: "هدية عند طلب فوق 199₪",
      name: "Gift over 199 ILS",
      giftProductId: firstProduct._id,
      giftVariantId: null,
      qty: 1,
      minOrderTotal: 199,
      requiredProductId: null,
      requiredCategoryId: null,
      startAt: nowPlusDays(-1),
      endAt: nowPlusDays(30),
      isActive: true,
    });
  }

  console.log("✅ Promos created");
  return { coupon, campaign, offerPercent, offerFreeShipping, offerBuyXGetY, gift };
}

/* =========================
   Verification
========================= */

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

  // Dangling refs: every order has valid userId; every order item has valid productId
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

/* =========================
   MAIN
========================= */

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

    // Optional: seed a couple of reviews (safe + moderated)
    if (products?.length >= 2) {
      await Review.create([
        {
          productId: products[0]._id,
          userId: user._id,
          userName: user.name,
          rating: 5,
          comment: "מוצר מעולה! איכות גבוהה מאוד.",
          isHidden: false,
          moderationStatus: "approved",
          moderatedBy: admin._id,
          moderatedAt: new Date(),
        },
        {
          productId: products[1]._id,
          userId: user._id,
          userName: user.name,
          rating: 4,
          comment: "ممتاز، لكن كنت أتمنى كمية أكبر.",
          isHidden: false,
          moderationStatus: "approved",
          moderatedBy: staff._id,
          moderatedAt: new Date(),
        },
      ]);
    }

    // Create sample orders for ranking data
    if (products?.length > 0 && user) {
      await createOrders(products, user, shipping, promos);
    }

    // Create sample ProductSignalDaily records to support ranking recalculation
    // This ensures ranking endpoints work correctly even after recalculateProductRanking runs
    console.log("🔄 Creating ranking signal data...");
    await createRankingSignals(products);
    console.log("✅ Ranking signal data created");

    // Recalculate ranking stats from signals (this updates Product.stats from ProductSignalDaily)
    console.log("🔄 Recalculating ranking stats...");
    const { recalculateProductRanking } = await import("../services/ranking.service.js");
    await recalculateProductRanking();
    console.log("✅ Ranking stats updated");

    // Verification: counts + sanity checks
    console.log("\n📋 Verification...");
    await runVerification();

    console.log("\n✅ SEED COMPLETED SUCCESSFULLY\n");
    console.log("🔐 Accounts created (emails only):");
    console.log(`  Admin: ${String(process.env.SEED_ADMIN_EMAIL).trim().toLowerCase()}`);
    console.log(`  Staff: ${String(process.env.SEED_STAFF_EMAIL).trim().toLowerCase()}`);
    console.log(`  Test:  ${String(process.env.SEED_TEST_EMAIL).trim().toLowerCase()}`);
  } catch (e) {
    console.error("❌ Seed failed:", e);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close().catch(() => { });
  }
}

/**
 * Create ProductSignalDaily records to support ranking calculations.
 * These signals ensure recalculateProductRanking produces meaningful rankings.
 *
 * Distribution strategy:
 * - views7d: Distribute across days 0-6 (last 7 days)
 * - cartAdds30d, wishlistAdds30d, soldCount30d: Distribute across days 0-29 (last 30 days)
 *
 * After recalculateProductRanking runs, the Product.stats will be repopulated
 * from these signals, giving approximately the original seeded values.
 */
async function createRankingSignals(products) {
  const now = new Date();
  const signals = [];

  for (const p of products) {
    if (!p?.stats) continue;

    const productId = p._id;
    const stats = p.stats;

    // Get the totals to distribute
    const totalViews7d = Math.max(0, Number(stats.views7d || 0));
    const totalCartAdds30d = Math.max(0, Number(stats.cartAdds30d || 0));
    const totalWishlistAdds30d = Math.max(0, Number(stats.wishlistAdds30d || 0));
    const totalSoldCount30d = Math.max(0, Number(stats.soldCount30d || 0));

    // Skip if no engagement data
    if (totalViews7d === 0 && totalCartAdds30d === 0 && totalWishlistAdds30d === 0 && totalSoldCount30d === 0) {
      continue;
    }

    // Create signals for the past 30 days
    for (let daysAgo = 0; daysAgo < 30; daysAgo++) {
      const day = new Date(now);
      day.setDate(day.getDate() - daysAgo);
      day.setUTCHours(0, 0, 0, 0);

      // Views: only for last 7 days (distribute evenly)
      const views = daysAgo < 7 ? Math.ceil(totalViews7d / 7) : 0;

      // Cart adds, wishlists, sales: distribute evenly across 30 days
      const addToCart = Math.ceil(totalCartAdds30d / 30);
      const wishlisted = Math.ceil(totalWishlistAdds30d / 30);
      const unitsSold = Math.ceil(totalSoldCount30d / 30);

      // Only add if there's actual data for this day
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
      // Ignore duplicate key errors (in case of re-runs)
      if (err?.code !== 11000) throw err;
    });
    console.log(`✅ Created ${signals.length} ProductSignalDaily records`);
  }
}

async function createOrders(products, user, shipping, promos) {
  console.log("📦 Creating sample orders...");

  const areas = shipping?.areas ?? [];
  const firstArea = areas[0];

  // Seed Counter so we can assign order numbers (BB-YYYY-NNNNNN)
  const year = new Date().getFullYear();
  await Counter.findOneAndUpdate(
    { key: "order", year },
    { $setOnInsert: { key: "order", year, seq: 0 } },
    { upsert: true }
  );

  const paidOrders = [];

  // Order 1: No discount, DELIVERY
  const order1Subtotal = products[0].price * 2;
  const order1ShippingFee = 25;
  const order1Total = order1Subtotal + order1ShippingFee;

  paidOrders.push({
    userId: user._id,
    paymentMethod: "cod",
    orderNumber: await getNextOrderNumber(Counter),
    items: [
      {
        productId: products[0]._id,
        titleHe: products[0].titleHe,
        titleAr: products[0].titleAr || "",
        title: products[0].titleHe,
        qty: 2,
        unitPrice: products[0].price,
        categoryId: products[0].categoryId,
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
      city: "Tel Aviv",
      street: "Rothschild 1",
      deliveryAreaId: firstArea?._id ?? null,
      deliveryAreaName: firstArea ? firstArea.nameHe || firstArea.name : "",
    }),
    status: "delivered",
    paidAt: new Date(),
    deliveredAt: new Date(),
  });

  // Order 2: No discount, STORE_PICKUP
  if (products[2]) {
    const order2Subtotal = products[0].price + products[2].price;
    const order2ShippingFee = 0;
    const order2Total = order2Subtotal + order2ShippingFee;

    paidOrders.push({
      userId: user._id,
      paymentMethod: "cod",
      orderNumber: await getNextOrderNumber(Counter),
      items: [
        {
          productId: products[0]._id,
          titleHe: products[0].titleHe,
          titleAr: products[0].titleAr || "",
          title: products[0].titleHe,
          qty: 1,
          unitPrice: products[0].price,
          categoryId: products[0].categoryId,
          variantId: "",
          variantSnapshot: {},
        },
        {
          productId: products[2]._id,
          titleHe: products[2].titleHe,
          titleAr: products[2].titleAr || "",
          title: products[2].titleHe,
          qty: 1,
          unitPrice: products[2].price,
          categoryId: products[2].categoryId,
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
        phone: "0500000000",
        fullName: user.name,
      }),
      status: "delivered",
      paidAt: new Date(),
      deliveredAt: new Date(),
    });
  }

  // Create orders 1 and 2 first
  for (const orderData of paidOrders) {
    await Order.create(orderData);
  }

  // Order 3: With campaign + coupon (and record redemption)
  let order3Created = false;
  if (products[1] && promos?.coupon && promos?.campaign) {
    const subtotalRaw = products[0].price * 2 + products[1].price; // 59.9*2 + 54.9
    const campaignAmount = Math.round((subtotalRaw * promos.campaign.value) / 100);
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
          productId: products[0]._id,
          titleHe: products[0].titleHe,
          titleAr: products[0].titleAr || "",
          title: products[0].titleHe,
          qty: 2,
          unitPrice: products[0].price,
          categoryId: products[0].categoryId,
          variantId: "",
          variantSnapshot: {},
        },
        {
          productId: products[1]._id,
          titleHe: products[1].titleHe,
          titleAr: products[1].titleAr || "",
          title: products[1].titleHe,
          qty: 1,
          unitPrice: products[1].price,
          categoryId: products[1].categoryId,
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
        campaignId: promos.campaign._id,
      }),
      shipping: buildOrderShipping({
        mode: "DELIVERY",
        phone: "0501111111",
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

    // Record coupon redemption and per-user usage (server-consistent)
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
    await Coupon.updateOne(
      { _id: promos.coupon._id },
      { $inc: { usedCount: 1 } }
    );
    order3Created = true;
  }

  const totalOrders = paidOrders.length + (order3Created ? 1 : 0);
  console.log(`✅ Created ${totalOrders} sample orders`);
}

main();
