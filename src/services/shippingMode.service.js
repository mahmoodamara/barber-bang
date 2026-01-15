// src/services/shippingMode.service.js
import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { StorePickupConfig } from "../models/StorePickupConfig.js";

export const SHIPPING_MODES = {
  DELIVERY: "DELIVERY",
  PICKUP_POINT: "PICKUP_POINT",
  STORE_PICKUP: "STORE_PICKUP",
};

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/**
 * Get all active delivery areas
 */
export async function getActiveAreas({ lang = "he" } = {}) {
  const areas = await DeliveryArea.find({ isActive: true })
    .sort({ sort: 1, createdAt: -1 })
    .lean();

  return areas.map((a) => ({
    id: String(a._id),
    code: a.code,
    name: lang === "ar" ? a.nameAr : a.nameHe,
    deliveryEnabled: a.deliveryEnabled,
    deliveryPriceMinor: a.deliveryPriceMinor,
    pickupPointsEnabled: a.pickupPointsEnabled,
    freeDeliveryAboveMinor: a.freeDeliveryAboveMinor,
    minSubtotalMinor: a.minSubtotalMinor,
  }));
}

/**
 * Get pickup points for a specific area
 */
export async function getPickupPointsForArea({ areaId, lang = "he" } = {}) {
  if (!areaId) return [];

  const points = await PickupPoint.find({ areaId, isActive: true })
    .sort({ sort: 1, createdAt: -1 })
    .lean();

  return points.map((p) => ({
    id: String(p._id),
    areaId: String(p.areaId),
    name: lang === "ar" ? p.nameAr : p.nameHe,
    address: lang === "ar" ? p.addressAr : p.addressHe,
    notes: lang === "ar" ? p.notesAr : p.notesHe,
    hours: lang === "ar" ? p.hoursAr : p.hoursHe,
    feeMinor: p.feeMinor,
    phone: p.phone,
    coordinates: p.coordinates,
  }));
}

/**
 * Get store pickup configuration
 */
export async function getStorePickupInfo({ lang = "he" } = {}) {
  let config = await StorePickupConfig.findOne({ configKey: "main" }).lean();

  if (!config) {
    // Return default config if none exists
    config = {
      nameHe: "החנות הראשית",
      nameAr: "المتجر الرئيسي",
      addressHe: "",
      addressAr: "",
      hoursHe: "",
      hoursAr: "",
      notesHe: "",
      notesAr: "",
      phone: "",
      coordinates: null,
      isActive: false,
    };
  }

  return {
    name: lang === "ar" ? config.nameAr : config.nameHe,
    address: lang === "ar" ? config.addressAr : config.addressHe,
    hours: lang === "ar" ? config.hoursAr : config.hoursHe,
    notes: lang === "ar" ? config.notesAr : config.notesHe,
    phone: config.phone,
    coordinates: config.coordinates,
    isActive: config.isActive,
    // Store pickup is ALWAYS free
    feeMinor: 0,
  };
}

/**
 * Validate shipping mode selection and compute shipping price
 * Returns: { valid, shippingPriceMinor, error? }
 */
export async function validateShippingMode({
  mode,
  areaId,
  pickupPointId,
  payableSubtotalMinor = 0,
  lang = "he",
}) {
  // STORE_PICKUP: always valid if active, always free
  if (mode === SHIPPING_MODES.STORE_PICKUP) {
    const storeConfig = await StorePickupConfig.findOne({ configKey: "main" }).lean();
    if (!storeConfig?.isActive) {
      return {
        valid: false,
        shippingPriceMinor: 0,
        error: { code: "STORE_PICKUP_UNAVAILABLE", message: "Store pickup is not available" },
      };
    }
    return {
      valid: true,
      shippingPriceMinor: 0,
      storePickup: {
        name: lang === "ar" ? storeConfig.nameAr : storeConfig.nameHe,
        address: lang === "ar" ? storeConfig.addressAr : storeConfig.addressHe,
      },
    };
  }

  // DELIVERY and PICKUP_POINT require areaId
  if (!areaId) {
    return {
      valid: false,
      shippingPriceMinor: 0,
      error: { code: "AREA_REQUIRED", message: "Area is required for this shipping mode" },
    };
  }

  const area = await DeliveryArea.findById(areaId).lean();
  if (!area || !area.isActive) {
    return {
      valid: false,
      shippingPriceMinor: 0,
      error: { code: "INVALID_AREA", message: "Invalid or inactive delivery area" },
    };
  }

  // DELIVERY mode
  if (mode === SHIPPING_MODES.DELIVERY) {
    if (!area.deliveryEnabled) {
      return {
        valid: false,
        shippingPriceMinor: 0,
        error: { code: "DELIVERY_NOT_AVAILABLE", message: "Delivery is not available in this area" },
      };
    }

    // Check minimum subtotal
    if (area.minSubtotalMinor && payableSubtotalMinor < area.minSubtotalMinor) {
      return {
        valid: false,
        shippingPriceMinor: 0,
        error: {
          code: "MIN_SUBTOTAL_NOT_MET",
          message: "Minimum order amount not met for delivery",
          minSubtotalMinor: area.minSubtotalMinor,
        },
      };
    }

    // Compute delivery price (check for free delivery threshold)
    let shippingPriceMinor = area.deliveryPriceMinor || 0;
    if (area.freeDeliveryAboveMinor && payableSubtotalMinor >= area.freeDeliveryAboveMinor) {
      shippingPriceMinor = 0;
    }

    return {
      valid: true,
      shippingPriceMinor,
      area: {
        id: String(area._id),
        code: area.code,
        name: lang === "ar" ? area.nameAr : area.nameHe,
      },
    };
  }

  // PICKUP_POINT mode
  if (mode === SHIPPING_MODES.PICKUP_POINT) {
    if (!area.pickupPointsEnabled) {
      return {
        valid: false,
        shippingPriceMinor: 0,
        error: { code: "PICKUP_POINTS_DISABLED", message: "Pickup points are disabled in this area" },
      };
    }

    if (!pickupPointId) {
      return {
        valid: false,
        shippingPriceMinor: 0,
        error: { code: "PICKUP_POINT_REQUIRED", message: "Pickup point is required" },
      };
    }

    const pickupPoint = await PickupPoint.findById(pickupPointId).lean();
    if (!pickupPoint || !pickupPoint.isActive) {
      return {
        valid: false,
        shippingPriceMinor: 0,
        error: { code: "INVALID_PICKUP_POINT", message: "Invalid or inactive pickup point" },
      };
    }

    // Verify pickup point belongs to the area
    if (String(pickupPoint.areaId) !== String(areaId)) {
      return {
        valid: false,
        shippingPriceMinor: 0,
        error: { code: "PICKUP_POINT_NOT_IN_AREA", message: "Pickup point does not belong to selected area" },
      };
    }

    return {
      valid: true,
      shippingPriceMinor: pickupPoint.feeMinor || 0,
      area: {
        id: String(area._id),
        code: area.code,
        name: lang === "ar" ? area.nameAr : area.nameHe,
      },
      pickupPoint: {
        id: String(pickupPoint._id),
        name: lang === "ar" ? pickupPoint.nameAr : pickupPoint.nameHe,
        address: lang === "ar" ? pickupPoint.addressAr : pickupPoint.addressHe,
      },
    };
  }

  return {
    valid: false,
    shippingPriceMinor: 0,
    error: { code: "INVALID_SHIPPING_MODE", message: "Invalid shipping mode" },
  };
}

/**
 * Compute available shipping modes based on current state
 */
export async function getAvailableShippingModes({ payableSubtotalMinor = 0, lang = "he" } = {}) {
  const available = [];

  // Check if DELIVERY is available in any area
  const deliveryAreas = await DeliveryArea.find({
    isActive: true,
    deliveryEnabled: true,
  }).lean();

  if (deliveryAreas.length > 0) {
    available.push({
      mode: SHIPPING_MODES.DELIVERY,
      available: true,
      areasCount: deliveryAreas.length,
    });
  }

  // Check if PICKUP_POINT is available
  const pickupAreas = await DeliveryArea.find({
    isActive: true,
    pickupPointsEnabled: true,
  }).lean();

  if (pickupAreas.length > 0) {
    const pickupPointsCount = await PickupPoint.countDocuments({
      areaId: { $in: pickupAreas.map((a) => a._id) },
      isActive: true,
    });

    if (pickupPointsCount > 0) {
      available.push({
        mode: SHIPPING_MODES.PICKUP_POINT,
        available: true,
        areasCount: pickupAreas.length,
        pointsCount: pickupPointsCount,
      });
    }
  }

  // Check if STORE_PICKUP is available
  const storeConfig = await StorePickupConfig.findOne({ configKey: "main" }).lean();
  if (storeConfig?.isActive) {
    available.push({
      mode: SHIPPING_MODES.STORE_PICKUP,
      available: true,
      // Store pickup is always free
      feeMinor: 0,
    });
  }

  return available;
}

/**
 * Build payment methods based on shipping mode
 */
export function buildPaymentMethodsForMode(mode) {
  const methods = ["stripe"];
  // COD available for pickup modes
  if (mode === SHIPPING_MODES.PICKUP_POINT || mode === SHIPPING_MODES.STORE_PICKUP) {
    methods.push("cod");
  }
  return methods;
}
