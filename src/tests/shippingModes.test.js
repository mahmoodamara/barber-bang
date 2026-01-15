// src/tests/shippingModes.test.js
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { ENV } from "../utils/env.js";
import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { StorePickupConfig } from "../models/StorePickupConfig.js";
import {
  SHIPPING_MODES,
  validateShippingMode,
  getActiveAreas,
  getPickupPointsForArea,
  getStorePickupInfo,
  getAvailableShippingModes,
  buildPaymentMethodsForMode,
} from "../services/shippingMode.service.js";

describe("Shipping Modes (3-mode system)", async () => {
  let testAreaId;
  let testPickupPointId;

  before(async () => {
    // Connect to test DB
    const dbUri = ENV.MONGODB_URI || "mongodb://localhost:27017/barber_test";
    await mongoose.connect(dbUri);
  });

  after(async () => {
    // Clean up test data
    if (testAreaId) await DeliveryArea.deleteOne({ _id: testAreaId });
    if (testPickupPointId) await PickupPoint.deleteOne({ _id: testPickupPointId });
    await StorePickupConfig.deleteOne({ configKey: "test_main" });
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    // Clean up before each test
    await DeliveryArea.deleteMany({ code: { $regex: /^TEST_/ } });
    await PickupPoint.deleteMany({ nameHe: { $regex: /^Test/ } });
  });

  describe("DELIVERY mode", async () => {
    it("should validate DELIVERY mode with valid area", async () => {
      // Create test area
      const area = await DeliveryArea.create({
        nameHe: "Test Area",
        nameAr: "منطقة اختبار",
        code: "TEST_AREA_1",
        deliveryEnabled: true,
        deliveryPriceMinor: 1500,
        isActive: true,
      });
      testAreaId = area._id;

      const result = await validateShippingMode({
        mode: SHIPPING_MODES.DELIVERY,
        areaId: String(area._id),
        payableSubtotalMinor: 10000,
        lang: "he",
      });

      assert.equal(result.valid, true);
      assert.equal(result.shippingPriceMinor, 1500);
      assert.ok(result.area);
      assert.equal(result.area.code, "TEST_AREA_1");
    });

    it("should reject DELIVERY when area has deliveryEnabled=false", async () => {
      const area = await DeliveryArea.create({
        nameHe: "Test No Delivery",
        nameAr: "منطقة بدون توصيل",
        code: "TEST_NO_DELIVERY",
        deliveryEnabled: false,
        isActive: true,
      });
      testAreaId = area._id;

      const result = await validateShippingMode({
        mode: SHIPPING_MODES.DELIVERY,
        areaId: String(area._id),
        payableSubtotalMinor: 10000,
        lang: "he",
      });

      assert.equal(result.valid, false);
      assert.equal(result.error.code, "DELIVERY_NOT_AVAILABLE");
    });

    it("should reject DELIVERY when area is inactive", async () => {
      const area = await DeliveryArea.create({
        nameHe: "Test Inactive",
        nameAr: "منطقة غير نشطة",
        code: "TEST_INACTIVE_AREA",
        deliveryEnabled: true,
        isActive: false,
      });
      testAreaId = area._id;

      const result = await validateShippingMode({
        mode: SHIPPING_MODES.DELIVERY,
        areaId: String(area._id),
        payableSubtotalMinor: 10000,
        lang: "he",
      });

      assert.equal(result.valid, false);
      assert.equal(result.error.code, "INVALID_AREA");
    });

    it("should apply free delivery when subtotal meets threshold", async () => {
      const area = await DeliveryArea.create({
        nameHe: "Test Free Delivery",
        nameAr: "منطقة توصيل مجاني",
        code: "TEST_FREE_DELIVERY",
        deliveryEnabled: true,
        deliveryPriceMinor: 2000,
        freeDeliveryAboveMinor: 15000,
        isActive: true,
      });
      testAreaId = area._id;

      // Below threshold
      let result = await validateShippingMode({
        mode: SHIPPING_MODES.DELIVERY,
        areaId: String(area._id),
        payableSubtotalMinor: 14000,
        lang: "he",
      });
      assert.equal(result.valid, true);
      assert.equal(result.shippingPriceMinor, 2000);

      // At threshold
      result = await validateShippingMode({
        mode: SHIPPING_MODES.DELIVERY,
        areaId: String(area._id),
        payableSubtotalMinor: 15000,
        lang: "he",
      });
      assert.equal(result.valid, true);
      assert.equal(result.shippingPriceMinor, 0);

      // Above threshold
      result = await validateShippingMode({
        mode: SHIPPING_MODES.DELIVERY,
        areaId: String(area._id),
        payableSubtotalMinor: 20000,
        lang: "he",
      });
      assert.equal(result.valid, true);
      assert.equal(result.shippingPriceMinor, 0);
    });

    it("should reject DELIVERY when minimum subtotal not met", async () => {
      const area = await DeliveryArea.create({
        nameHe: "Test Min Subtotal",
        nameAr: "منطقة حد أدنى",
        code: "TEST_MIN_SUBTOTAL",
        deliveryEnabled: true,
        deliveryPriceMinor: 1500,
        minSubtotalMinor: 5000,
        isActive: true,
      });
      testAreaId = area._id;

      const result = await validateShippingMode({
        mode: SHIPPING_MODES.DELIVERY,
        areaId: String(area._id),
        payableSubtotalMinor: 4000,
        lang: "he",
      });

      assert.equal(result.valid, false);
      assert.equal(result.error.code, "MIN_SUBTOTAL_NOT_MET");
    });
  });

  describe("PICKUP_POINT mode", async () => {
    it("should validate PICKUP_POINT with valid area and point", async () => {
      const area = await DeliveryArea.create({
        nameHe: "Test Pickup Area",
        nameAr: "منطقة نقطة استلام",
        code: "TEST_PICKUP_AREA",
        pickupPointsEnabled: true,
        isActive: true,
      });
      testAreaId = area._id;

      const point = await PickupPoint.create({
        areaId: area._id,
        nameHe: "Test Pickup Point",
        nameAr: "نقطة استلام اختبار",
        addressHe: "123 Test St",
        addressAr: "123 شارع الاختبار",
        feeMinor: 500,
        isActive: true,
      });
      testPickupPointId = point._id;

      const result = await validateShippingMode({
        mode: SHIPPING_MODES.PICKUP_POINT,
        areaId: String(area._id),
        pickupPointId: String(point._id),
        lang: "he",
      });

      assert.equal(result.valid, true);
      assert.equal(result.shippingPriceMinor, 500);
      assert.ok(result.pickupPoint);
      assert.equal(result.pickupPoint.name, "Test Pickup Point");
    });

    it("should reject PICKUP_POINT when point not in area", async () => {
      const area1 = await DeliveryArea.create({
        nameHe: "Area 1",
        nameAr: "منطقة 1",
        code: "TEST_AREA_1_PP",
        pickupPointsEnabled: true,
        isActive: true,
      });

      const area2 = await DeliveryArea.create({
        nameHe: "Area 2",
        nameAr: "منطقة 2",
        code: "TEST_AREA_2_PP",
        pickupPointsEnabled: true,
        isActive: true,
      });

      const point = await PickupPoint.create({
        areaId: area1._id,
        nameHe: "Test Point in Area 1",
        nameAr: "نقطة في منطقة 1",
        addressHe: "123 Test St",
        addressAr: "123 شارع الاختبار",
        isActive: true,
      });
      testPickupPointId = point._id;

      // Try to use point from area1 with area2
      const result = await validateShippingMode({
        mode: SHIPPING_MODES.PICKUP_POINT,
        areaId: String(area2._id),
        pickupPointId: String(point._id),
        lang: "he",
      });

      assert.equal(result.valid, false);
      assert.equal(result.error.code, "PICKUP_POINT_NOT_IN_AREA");

      // Cleanup
      await DeliveryArea.deleteMany({ _id: { $in: [area1._id, area2._id] } });
    });

    it("should reject PICKUP_POINT when point is inactive", async () => {
      const area = await DeliveryArea.create({
        nameHe: "Test Area",
        nameAr: "منطقة اختبار",
        code: "TEST_AREA_INACTIVE_PP",
        pickupPointsEnabled: true,
        isActive: true,
      });
      testAreaId = area._id;

      const point = await PickupPoint.create({
        areaId: area._id,
        nameHe: "Test Inactive Point",
        nameAr: "نقطة غير نشطة",
        addressHe: "123 Test St",
        addressAr: "123 شارع الاختبار",
        isActive: false,
      });
      testPickupPointId = point._id;

      const result = await validateShippingMode({
        mode: SHIPPING_MODES.PICKUP_POINT,
        areaId: String(area._id),
        pickupPointId: String(point._id),
        lang: "he",
      });

      assert.equal(result.valid, false);
      assert.equal(result.error.code, "INVALID_PICKUP_POINT");
    });

    it("should reject PICKUP_POINT when area has pickupPointsEnabled=false", async () => {
      const area = await DeliveryArea.create({
        nameHe: "Test No Pickup",
        nameAr: "منطقة بدون نقاط",
        code: "TEST_NO_PICKUP_POINTS",
        pickupPointsEnabled: false,
        isActive: true,
      });
      testAreaId = area._id;

      const result = await validateShippingMode({
        mode: SHIPPING_MODES.PICKUP_POINT,
        areaId: String(area._id),
        pickupPointId: "507f1f77bcf86cd799439011",
        lang: "he",
      });

      assert.equal(result.valid, false);
      assert.equal(result.error.code, "PICKUP_POINTS_DISABLED");
    });
  });

  describe("STORE_PICKUP mode", async () => {
    it("should validate STORE_PICKUP when store is active", async () => {
      // Create or update store config
      await StorePickupConfig.updateOne(
        { configKey: "main" },
        {
          $set: {
            nameHe: "החנות הראשית",
            nameAr: "المتجر الرئيسي",
            addressHe: "רחוב הראשי 1",
            addressAr: "الشارع الرئيسي 1",
            isActive: true,
          },
        },
        { upsert: true }
      );

      const result = await validateShippingMode({
        mode: SHIPPING_MODES.STORE_PICKUP,
        lang: "he",
      });

      assert.equal(result.valid, true);
      assert.equal(result.shippingPriceMinor, 0); // Store pickup is always free
      assert.ok(result.storePickup);
    });

    it("should reject STORE_PICKUP when store is inactive", async () => {
      await StorePickupConfig.updateOne(
        { configKey: "main" },
        { $set: { isActive: false } },
        { upsert: true }
      );

      const result = await validateShippingMode({
        mode: SHIPPING_MODES.STORE_PICKUP,
        lang: "he",
      });

      assert.equal(result.valid, false);
      assert.equal(result.error.code, "STORE_PICKUP_UNAVAILABLE");
    });

    it("should always have shipping price = 0 for STORE_PICKUP", async () => {
      await StorePickupConfig.updateOne(
        { configKey: "main" },
        { $set: { isActive: true } },
        { upsert: true }
      );

      const result = await validateShippingMode({
        mode: SHIPPING_MODES.STORE_PICKUP,
        payableSubtotalMinor: 0,
        lang: "he",
      });

      assert.equal(result.valid, true);
      assert.equal(result.shippingPriceMinor, 0);
    });
  });

  describe("Payment methods per mode", async () => {
    it("should allow only stripe for DELIVERY", () => {
      const methods = buildPaymentMethodsForMode(SHIPPING_MODES.DELIVERY);
      assert.deepEqual(methods, ["stripe"]);
    });

    it("should allow stripe and cod for PICKUP_POINT", () => {
      const methods = buildPaymentMethodsForMode(SHIPPING_MODES.PICKUP_POINT);
      assert.ok(methods.includes("stripe"));
      assert.ok(methods.includes("cod"));
    });

    it("should allow stripe and cod for STORE_PICKUP", () => {
      const methods = buildPaymentMethodsForMode(SHIPPING_MODES.STORE_PICKUP);
      assert.ok(methods.includes("stripe"));
      assert.ok(methods.includes("cod"));
    });
  });

  describe("getActiveAreas", async () => {
    it("should return only active areas", async () => {
      await DeliveryArea.create([
        { nameHe: "Active Area", nameAr: "نشط", code: "TEST_ACTIVE", isActive: true },
        { nameHe: "Inactive Area", nameAr: "غير نشط", code: "TEST_INACTIVE", isActive: false },
      ]);

      const areas = await getActiveAreas({ lang: "he" });
      const codes = areas.map((a) => a.code);

      assert.ok(codes.includes("TEST_ACTIVE"));
      assert.ok(!codes.includes("TEST_INACTIVE"));
    });
  });

  describe("getPickupPointsForArea", async () => {
    it("should return only active pickup points for area", async () => {
      const area = await DeliveryArea.create({
        nameHe: "Test Area",
        nameAr: "منطقة",
        code: "TEST_PICKUP_LIST",
        isActive: true,
      });
      testAreaId = area._id;

      await PickupPoint.create([
        {
          areaId: area._id,
          nameHe: "Active Point",
          nameAr: "نقطة نشطة",
          addressHe: "Active",
          addressAr: "نشط",
          isActive: true,
        },
        {
          areaId: area._id,
          nameHe: "Inactive Point",
          nameAr: "نقطة غير نشطة",
          addressHe: "Inactive",
          addressAr: "غير نشط",
          isActive: false,
        },
      ]);

      const points = await getPickupPointsForArea({ areaId: String(area._id), lang: "he" });
      const names = points.map((p) => p.name);

      assert.ok(names.includes("Active Point"));
      assert.ok(!names.includes("Inactive Point"));
    });
  });

  describe("No duplicate shipping calculations", async () => {
    it("should compute shipping price exactly once", async () => {
      const area = await DeliveryArea.create({
        nameHe: "Test Area",
        nameAr: "منطقة",
        code: "TEST_NO_DUPLICATE",
        deliveryEnabled: true,
        deliveryPriceMinor: 1500,
        isActive: true,
      });
      testAreaId = area._id;

      // Validate multiple times
      const result1 = await validateShippingMode({
        mode: SHIPPING_MODES.DELIVERY,
        areaId: String(area._id),
        payableSubtotalMinor: 10000,
      });

      const result2 = await validateShippingMode({
        mode: SHIPPING_MODES.DELIVERY,
        areaId: String(area._id),
        payableSubtotalMinor: 10000,
      });

      // Both should return the same price (not accumulated)
      assert.equal(result1.shippingPriceMinor, 1500);
      assert.equal(result2.shippingPriceMinor, 1500);
      assert.equal(result1.shippingPriceMinor, result2.shippingPriceMinor);
    });
  });
});
