// src/controllers/adminStorePickup.controller.js
import { StorePickupConfig } from "../models/StorePickupConfig.js";

function toDTO(doc) {
  if (!doc) return null;
  const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    id: String(obj._id),
    nameHe: obj.nameHe,
    nameAr: obj.nameAr,
    addressHe: obj.addressHe,
    addressAr: obj.addressAr,
    hoursHe: obj.hoursHe,
    hoursAr: obj.hoursAr,
    notesHe: obj.notesHe,
    notesAr: obj.notesAr,
    phone: obj.phone,
    coordinates: obj.coordinates || null,
    isActive: obj.isActive,
    // Fee is ALWAYS 0 for store pickup
    feeMinor: 0,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

// GET /admin/store-pickup
export async function getStorePickupConfig(req, res) {
  // Get or create singleton config
  let doc = await StorePickupConfig.findOne({ configKey: "main" });
  
  if (!doc) {
    // Create default config
    doc = new StorePickupConfig({ configKey: "main" });
    await doc.save();
  }

  res.json({ ok: true, data: toDTO(doc) });
}

// PATCH /admin/store-pickup
export async function updateStorePickupConfig(req, res) {
  const body = req.validated?.body || req.body;

  // Get or create singleton config
  let doc = await StorePickupConfig.findOne({ configKey: "main" });
  
  if (!doc) {
    doc = new StorePickupConfig({ configKey: "main" });
  }

  // Apply updates (but never allow fee to be set - it's always 0)
  const { feeMinor, ...safeBody } = body;
  Object.assign(doc, safeBody);
  await doc.save();

  res.json({ ok: true, data: toDTO(doc) });
}
