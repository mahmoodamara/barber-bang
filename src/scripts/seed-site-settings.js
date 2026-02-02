import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { SiteSettings } from "../models/SiteSettings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root (two levels up from scripts/)
dotenv.config({ path: resolve(__dirname, "../../.env") });

/* =========================
   Guards
========================= */

/**
 * Prevent accidental execution in production
 */
function assertNotProduction() {
  const env = String(process.env.NODE_ENV || "").toLowerCase();
  if (env === "production") {
    console.error("❌ SiteSettings seed is disabled in production");
    process.exit(1);
  }
}

/* =========================
   Seed Logic
========================= */

async function wipeSiteSettings() {
  console.log("🧹 Removing existing SiteSettings...");
  await SiteSettings.deleteMany({});
}

async function createSiteSettings() {
  console.log("⚙️ Creating new SiteSettings...");

  return SiteSettings.create({
    /* =========================
       Basic Store Info
    ========================= */
    storeNameHe: "Barber Bang",
    storeNameAr: "Barber Bang",

    logoUrl: "",
    faviconUrl: "",

    whatsappNumber: "+972545983684",
    phone: "+972545983684",
    email: "thebigbangcosmetics@gmail.com",

    addressHe: "מג'אר",
    addressAr: "المغار",

    // 🕒 Work all days except Monday
    businessHoursHe: "א׳, ג׳-ש׳ 10:00-20:00 (סגור ביום ב׳)",
    businessHoursAr: "جميع الأيام 10:00 - 20:00 (مغلق يوم الإثنين)",

    /* =========================
       Social Links
    ========================= */
    socialLinks: {
      instagram: "",
      facebook: "",
      tiktok: "",
    },

    /* =========================
       Top Bar
    ========================= */
    topBar: {
      enabled: true,
      textHe: "משלוח מהיר לכל אזור הצפון",
      textAr: "توصيل سريع لجميع مناطق الشمال",
      link: "/shop",
    },

    /* =========================
       SEO Defaults
    ========================= */
    seoDefaults: {
      titleHe: "Barber Bang | מוצרי טיפוח לגברים",
      titleAr: "Barber Bang | منتجات عناية للرجال",
      descriptionHe: "מוצרי שיער, זקן וגילוח באיכות גבוהה – משלוח מהיר ממג׳אר.",
      descriptionAr: "منتجات شعر، لحية وحلاقة بجودة عالية – توصيل سريع من المغار.",
      ogImage: "",
    },

    /* =========================
       Maintenance Mode
    ========================= */
    maintenanceMode: {
      enabled: false,
      messageHe: "",
      messageAr: "",
    },

    /* =========================
       Checkout Rules (Maghar - IL)
       All values in minor units (₪ × 100)
    ========================= */
    checkoutRules: {
      enableCOD: true,
      codFeeMinor: 1000,               // 10₪
      freeShippingThresholdMinor: 17900, // 179₪
      minOrderAmountMinor: 2500,       // 25₪
    },

    /* =========================
       Pricing Rules
    ========================= */
    pricingRules: {
      pricesIncludeVat: true, // IL B2C default
    },
  });
}

/* =========================
   Main
========================= */

async function main() {
  assertNotProduction();
  await connectDB();

  try {
    await wipeSiteSettings();
    await createSiteSettings();
    console.log("✅ SiteSettings seed completed successfully");
  } catch (error) {
    console.error("❌ SiteSettings seed failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

main();
