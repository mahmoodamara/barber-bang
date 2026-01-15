// src/controllers/adminPickupPoints.controller.js
import { PickupPoint } from "../models/PickupPoint.js";
import { DeliveryArea } from "../models/DeliveryArea.js";

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
    areaId: obj.areaId ? String(obj.areaId) : null,
    nameHe: obj.nameHe,
    nameAr: obj.nameAr,
    addressHe: obj.addressHe,
    addressAr: obj.addressAr,
    notesHe: obj.notesHe,
    notesAr: obj.notesAr,
    hoursHe: obj.hoursHe,
    hoursAr: obj.hoursAr,
    feeMinor: obj.feeMinor,
    phone: obj.phone,
    coordinates: obj.coordinates || null,
    sort: obj.sort,
    isActive: obj.isActive,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

// GET /admin/pickup-points
export async function listPickupPoints(req, res) {
  const includeInactive = String(req.query?.includeInactive) === "1";
  const areaId = req.query?.areaId;

  const filter = {};
  if (!includeInactive) filter.isActive = true;
  if (areaId) filter.areaId = areaId;

  const items = await PickupPoint.find(filter).sort({ areaId: 1, sort: 1, createdAt: -1 }).lean();

  res.json({ ok: true, data: { items: items.map(toDTO) } });
}

// GET /admin/pickup-points/:id
export async function getPickupPoint(req, res) {
  const { id } = req.params;
  const doc = await PickupPoint.findById(id).lean();
  if (!doc) throw httpError(404, "PICKUP_POINT_NOT_FOUND", "Pickup point not found");

  res.json({ ok: true, data: toDTO(doc) });
}

// POST /admin/pickup-points
export async function createPickupPoint(req, res) {
  const body = req.validated?.body || req.body;

  // Verify area exists and is active
  const area = await DeliveryArea.findById(body.areaId).lean();
  if (!area) {
    throw httpError(400, "INVALID_AREA", "Delivery area not found");
  }
  if (!area.isActive) {
    throw httpError(400, "AREA_INACTIVE", "Cannot add pickup point to inactive area");
  }
  if (!area.pickupPointsEnabled) {
    throw httpError(400, "PICKUP_POINTS_DISABLED", "Pickup points are disabled for this area");
  }

  const doc = new PickupPoint(body);
  await doc.save();

  res.status(201).json({ ok: true, data: toDTO(doc) });
}

// PATCH /admin/pickup-points/:id
export async function updatePickupPoint(req, res) {
  const { id } = req.params;
  const body = req.validated?.body || req.body;

  const doc = await PickupPoint.findById(id);
  if (!doc) throw httpError(404, "PICKUP_POINT_NOT_FOUND", "Pickup point not found");

  // If changing area, verify new area
  if (body.areaId && body.areaId !== String(doc.areaId)) {
    const area = await DeliveryArea.findById(body.areaId).lean();
    if (!area) {
      throw httpError(400, "INVALID_AREA", "Delivery area not found");
    }
    if (!area.isActive) {
      throw httpError(400, "AREA_INACTIVE", "Cannot move pickup point to inactive area");
    }
    if (!area.pickupPointsEnabled) {
      throw httpError(400, "PICKUP_POINTS_DISABLED", "Pickup points are disabled for this area");
    }
  }

  Object.assign(doc, body);
  await doc.save();

  res.json({ ok: true, data: toDTO(doc) });
}

// DELETE /admin/pickup-points/:id (soft delete)
export async function deactivatePickupPoint(req, res) {
  const { id } = req.params;

  const doc = await PickupPoint.findById(id);
  if (!doc) throw httpError(404, "PICKUP_POINT_NOT_FOUND", "Pickup point not found");

  doc.isActive = false;
  await doc.save();

  res.json({ ok: true, data: toDTO(doc) });
}
