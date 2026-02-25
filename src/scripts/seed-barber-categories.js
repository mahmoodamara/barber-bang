/**
 * Supplementary seed script: adds barber-specific categories
 * that are missing from the main seed (razors, scissors, consumables, furniture).
 *
 * Safe to run multiple times - skips categories that already exist (by nameHe).
 *
 * Usage: node --experimental-modules src/scripts/seed-barber-categories.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { Category } from "../models/Category.js";

const NEW_CATEGORIES = [
  {
    nameHe: "סכיני גילוח ולהבים",
    nameAr: "أمواس وشفرات الحلاقة",
    descriptionHe: "סכיני גילוח ידניים, שליטרים ולהבים חד-פעמיים לברברים.",
    descriptionAr: "أمواس حلاقة يدوية وشفرات أحادية الاستخدام للباربر.",
    isActive: true,
    sortOrder: 25,
    metaTitleHe: "סכיני גילוח ולהבים | Barber Bang",
    metaTitleAr: "أمواس وشفرات الحلاقة | Barber Bang",
    metaDescriptionHe: "סכיני גילוח, שליטרים ולהבים מקצועיים לברבר.",
    metaDescriptionAr: "أمواس وشفرات حلاقة احترافية للباربر.",
  },
  {
    nameHe: "מספריים מקצועיים",
    nameAr: "مقصات احترافية",
    descriptionHe: "מספריים לתספורת, מספריי דילול ומספריים טקסטורה לברברים.",
    descriptionAr: "مقصات قص، مقصات تخفيف ومقصات تدريج للحلاقين.",
    isActive: true,
    sortOrder: 27,
    metaTitleHe: "מספריים מקצועיים | Barber Bang",
    metaTitleAr: "مقصات احترافية | Barber Bang",
    metaDescriptionHe: "מספריים מקצועיים לתספורת ודילול.",
    metaDescriptionAr: "مقصات احترافية للقص والتخفيف.",
  },
  {
    nameHe: "מתכלים למספרה",
    nameAr: "استهلاكيات المحل",
    descriptionHe: "גלימות, מגבות, צווארוני נייר, כפפות ואביזרים חד-פעמיים.",
    descriptionAr:
      "كيبات، مناشف، أطواق ورقية، قفازات ومستلزمات أحادية الاستخدام.",
    isActive: true,
    sortOrder: 85,
    metaTitleHe: "מתכלים למספרה | Barber Bang",
    metaTitleAr: "استهلاكيات المحل | Barber Bang",
    metaDescriptionHe: "מוצרים חד-פעמיים ומתכלים למספרה מקצועית.",
    metaDescriptionAr: "مستلزمات أحادية الاستخدام واستهلاكيات للمحل الاحترافي.",
  },
  {
    nameHe: "ריהוט וציוד למספרה",
    nameAr: "أثاث وتجهيزات المحل",
    descriptionHe: "כיסאות ברבר, מראות, עגלות עבודה וציוד נלווה למספרה.",
    descriptionAr: "كراسي باربر، مرايا، عربات عمل وتجهيزات للمحل.",
    isActive: true,
    sortOrder: 95,
    metaTitleHe: "ריהוט וציוד למספרה | Barber Bang",
    metaTitleAr: "أثاث وتجهيزات المحل | Barber Bang",
    metaDescriptionHe: "ריהוט וציוד מקצועי להקמת מספרה.",
    metaDescriptionAr: "أثاث وتجهيزات احترافية لتأسيس محل الباربر.",
  },
  {
    nameHe: "בשמים וקולוניות ברבר",
    nameAr: "عطور وكولونيا باربر",
    descriptionHe: "קולוניות אפטר שייב, בשמים ודאודורנטים לגבר.",
    descriptionAr: "كولونيا بعد الحلاقة، عطور ومزيلات عرق للرجال.",
    isActive: true,
    sortOrder: 75,
    metaTitleHe: "בשמים וקולוניות ברבר | Barber Bang",
    metaTitleAr: "عطور وكولونيا باربر | Barber Bang",
    metaDescriptionHe: "קולוניות ובשמים איכותיים לברברים.",
    metaDescriptionAr: "كولونيا وعطور عالية الجودة للباربر.",
  },
];

async function run() {
  await connectDB();
  console.log("🔧 Adding barber-specific categories...\n");

  let created = 0;
  let skipped = 0;

  for (const cat of NEW_CATEGORIES) {
    const existing = await Category.findOne({ nameHe: cat.nameHe });
    if (existing) {
      console.log(`  ⏭  "${cat.nameHe}" already exists – skipping`);
      skipped++;
      continue;
    }

    await Category.create(cat);
    console.log(`  ✅ Created: "${cat.nameHe}" / "${cat.nameAr}"`);
    created++;
  }

  console.log(`\n📊 Done — created: ${created}, skipped: ${skipped}`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
