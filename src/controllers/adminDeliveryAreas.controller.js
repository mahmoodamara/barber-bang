// src/controllers/adminDeliveryAreas.controller.js
import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function toDTO(doc) {
  if (!doc) return null;
  const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    id: String(obj._id),
    nameHe: obj.nameHe,
    nameAr: obj.nameAr,
    code: obj.code,
    deliveryEnabled: obj.deliveryEnabled,
    deliveryPriceMinor: obj.deliveryPriceMinor,
    pickupPointsEnabled: obj.pickupPointsEnabled,
    freeDeliveryAboveMinor: obj.freeDeliveryAboveMinor,
    minSubtotalMinor: obj.minSubtotalMinor,
    sort: obj.sort,
    isActive: obj.isActive,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

// GET /admin/delivery-areas
export async function listDeliveryAreas(req, res) {
  const includeInactive = String(req.query?.includeInactive) === "1";
  const filter = includeInactive ? {} : { isActive: true };

  const items = await DeliveryArea.find(filter).sort({ sort: 1, createdAt: -1 }).lean();

  res.json({ ok: true, data: { items: items.map(toDTO) } });
}

// GET /admin/delivery-areas/:id
export async function getDeliveryArea(req, res) {
  const { id } = req.params;
  const doc = await DeliveryArea.findById(id).lean();
  if (!doc) throw httpError(404, "AREA_NOT_FOUND", "Delivery area not found");

  res.json({ ok: true, data: toDTO(doc) });
}

// POST /admin/delivery-areas
export async function createDeliveryArea(req, res) {
  const body = req.validated?.body || req.body;

  // Check for duplicate code
  const existing = await DeliveryArea.findOne({ code: body.code }).lean();
  if (existing) {
    throw httpError(409, "AREA_CODE_EXISTS", "Delivery area with this code already exists");
  }

  const doc = new DeliveryArea(body);
  await doc.save();

  res.status(201).json({ ok: true, data: toDTO(doc) });
}

// PATCH /admin/delivery-areas/:id
export async function updateDeliveryArea(req, res) {
  const { id } = req.params;
  const body = req.validated?.body || req.body;

  const doc = await DeliveryArea.findById(id);
  if (!doc) throw httpError(404, "AREA_NOT_FOUND", "Delivery area not found");

  // Check for duplicate code if changing
  if (body.code && body.code !== doc.code) {
    const existing = await DeliveryArea.findOne({ code: body.code, _id: { $ne: id } }).lean();
    if (existing) {
      throw httpError(409, "AREA_CODE_EXISTS", "Delivery area with this code already exists");
    }
  }

  Object.assign(doc, body);
  await doc.save();

  res.json({ ok: true, data: toDTO(doc) });
}

// DELETE /admin/delivery-areas/:id (soft delete)
export async function deactivateDeliveryArea(req, res) {
  const { id } = req.params;

  const doc = await DeliveryArea.findById(id);
  if (!doc) throw httpError(404, "AREA_NOT_FOUND", "Delivery area not found");

  // Also deactivate all pickup points in this area
  await PickupPoint.updateMany({ areaId: id }, { $set: { isActive: false } });

  doc.isActive = false;
  await doc.save();

  res.json({ ok: true, data: toDTO(doc) });
}
