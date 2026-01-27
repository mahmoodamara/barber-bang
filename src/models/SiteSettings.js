import mongoose from "mongoose";

const siteSettingsSchema = new mongoose.Schema(
  {
    storeNameHe: { type: String, trim: true },
    storeNameAr: { type: String, trim: true },
    logoUrl: { type: String, trim: true },
    faviconUrl: { type: String, trim: true },
    whatsappNumber: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    addressHe: { type: String, trim: true },
    addressAr: { type: String, trim: true },
    businessHoursHe: { type: String, trim: true },
    businessHoursAr: { type: String, trim: true },
    socialLinks: {
      instagram: { type: String, trim: true },
      facebook: { type: String, trim: true },
      tiktok: { type: String, trim: true },
    },
    topBar: {
      enabled: { type: Boolean, default: false },
      textHe: { type: String, trim: true },
      textAr: { type: String, trim: true },
      link: { type: String, trim: true },
    },
    seoDefaults: {
      titleHe: { type: String, trim: true },
      titleAr: { type: String, trim: true },
      descriptionHe: { type: String, trim: true },
      descriptionAr: { type: String, trim: true },
      ogImage: { type: String, trim: true },
    },
    maintenanceMode: {
      enabled: { type: Boolean, default: false },
      messageHe: { type: String, trim: true },
      messageAr: { type: String, trim: true },
    },
    checkoutRules: {
      enableCOD: { type: Boolean, default: true },
      codFeeMinor: { type: Number, default: 0, min: 0 },
      freeShippingThresholdMinor: { type: Number, default: 0, min: 0 },
      minOrderAmountMinor: { type: Number, default: 0, min: 0 },
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true, // Enables __v check on save()
    autoCreate: true, // Ensure collection is created
  }
);

// Start with a singleton document if possible, but handled in controller
export const SiteSettings = mongoose.model("SiteSettings", siteSettingsSchema);
