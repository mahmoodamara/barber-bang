// src/controllers/publicShipping.controller.js
import {
  getActiveAreas,
  getPickupPointsForArea,
  getStorePickupInfo,
  getAvailableShippingModes,
  SHIPPING_MODES,
} from "../services/shippingMode.service.js";

/**
 * GET /shipping/areas
 * Public: List active delivery areas
 */
export async function listAreas(req, res) {
  const lang = req.lang || "he";
  const areas = await getActiveAreas({ lang });

  res.json({
    ok: true,
    data: { areas },
  });
}

/**
 * GET /shipping/areas/:areaId/pickup-points
 * Public: List pickup points for a specific area
 */
export async function listPickupPointsForArea(req, res) {
  const { areaId } = req.params;
  const lang = req.lang || "he";

  const pickupPoints = await getPickupPointsForArea({ areaId, lang });

  res.json({
    ok: true,
    data: { areaId, pickupPoints },
  });
}

/**
 * GET /shipping/store-pickup
 * Public: Get store pickup configuration
 */
export async function getStorePickup(req, res) {
  const lang = req.lang || "he";
  const storePickup = await getStorePickupInfo({ lang });

  res.json({
    ok: true,
    data: { storePickup },
  });
}

/**
 * GET /shipping/modes
 * Public: Get available shipping modes
 */
export async function listShippingModes(req, res) {
  const lang = req.lang || "he";
  const modes = await getAvailableShippingModes({ lang });

  res.json({
    ok: true,
    data: {
      modes,
      available: modes.map((m) => m.mode),
    },
  });
}
