// src/routes/admin.dashboard.routes.js
import express from "express";
import { DateTime } from "luxon";

import { Order } from "../models/Order.js";
import { ReturnRequest } from "../models/ReturnRequest.js";
import { Product } from "../models/Product.js";

import { requireAuth, requireAnyPermission, PERMISSIONS } from "../middleware/auth.js";
import { sendOk, sendError } from "../utils/response.js";

const router = express.Router();

/**
 * ============================
 * Auth + RBAC
 * Admin is typically handled inside requireAnyPermission (role-based bypass).
 * Staff must have at least one of the listed permissions.
 * ============================
 */
router.use(requireAuth());
router.use(
  requireAnyPermission(
    PERMISSIONS.ORDERS_WRITE,
    PERMISSIONS.PRODUCTS_WRITE,
    PERMISSIONS.SETTINGS_WRITE
  )
);

/* ============================
   Config
============================ */

const BUSINESS_TZ = "Asia/Jerusalem";

/**
 * Israel country code standard (recommended).
 * Keep DB normalized to ISO-3166 alpha-2: "IL".
 */
const ISRAEL_COUNTRY_CODE = "IL";

/**
 * Where country code might exist in your order schema.
 * Put the REAL path first for best index usage.
 */
const COUNTRY_PATHS = [
  "shipping.address.countryCode",
  "shipping.countryCode",
  "delivery.address.countryCode",
  "billing.address.countryCode",
];

/**
 * Paid statuses used for revenue + top products (business definition).
 * Adjust to match your lifecycle.
 */
const PAID_STATUSES = [
  "paid",
  "payment_received",
  "stock_confirmed",
  "confirmed",
  "shipped",
  "delivered",
  "partially_refunded",
];

const PENDING_FULFILLMENT_STATUSES = [
  "pending_payment",
  "pending_cod",
  "cod_pending_approval",
  "paid",
  "payment_received",
  "stock_confirmed",
  "confirmed",
];

/* ============================
   Tiny in-memory cache (optional)
   - protects DB from dashboard refresh storms
   - good for single-node; for multi-node use Redis
============================ */

const DASHBOARD_CACHE_TTL_MS = 20_000; // 20s (tweak)
const cache = new Map(); // key -> { expiresAt, value }

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs = DASHBOARD_CACHE_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/* ============================
   Helpers
============================ */

function jsonErr(res, e) {
  return sendError(
    res,
    e.statusCode || 500,
    e.code || "INTERNAL_ERROR",
    e.message || "Unexpected error"
  );
}

function startOfDayInTZ(date = new Date(), tz = BUSINESS_TZ) {
  return DateTime.fromJSDate(date, { zone: tz }).startOf("day").toJSDate();
}

function daysAgoStartInTZ(days, tz = BUSINESS_TZ) {
  return DateTime.now().setZone(tz).minus({ days }).startOf("day").toJSDate();
}

/**
 * Build a Mongo match that filters orders to Israel only.
 * Uses $or across multiple possible schema paths.
 *
 * IMPORTANT: For best performance, normalize to ONE field and index it.
 */
function israelOrdersMatch() {
  return {
    $or: COUNTRY_PATHS.map((path) => ({ [path]: ISRAEL_COUNTRY_CODE })),
  };
}

/**
 * Safe numeric sum field fallback
 */
function ifNullNumber(path, fallback = 0) {
  return { $ifNull: [path, fallback] };
}

/* ============================
   GET /api/v1/admin/dashboard
   KPI Dashboard endpoint (Israel sales only)
============================ */

router.get("/", async (req, res) => {
  try {
    // Cache key is constant here because the dashboard is global (no params)
    const cacheKey = "admin:dashboard:israel:v1";
    const cached = cacheGet(cacheKey);
    if (cached) return sendOk(res, cached);

    const now = new Date();

    // Israel-local day boundaries (correct business reporting)
    const todayStart = startOfDayInTZ(now, BUSINESS_TZ);
    const sevenDaysAgo = daysAgoStartInTZ(7, BUSINESS_TZ);
    const thirtyDaysAgo = daysAgoStartInTZ(30, BUSINESS_TZ);

    // Base Israel filter for orders
    const israelMatch = israelOrdersMatch();

    // Collection name for safe $lookup without hardcoding pluralization
    const ORDERS_COLLECTION = Order.collection.name;

    /**
     * Run queries in parallel for throughput.
     * Notes:
     * - Use aggregation for counts that can scale.
     * - Keep projections lean for lists.
     */
    const [
      revenueTodayResult,
      revenue7dResult,
      revenue30dResult,
      ordersTodayCount,
      ordersPendingCount,

      // Returns (Israel only via lookup on orderId -> Order._id)
      returnsOpenCountResult,

      lowStockCount,
      activeUsers30dResult,
      topProductsResult,
      latestOrders,
      latestReturnsAgg,
    ] = await Promise.all([
      // Revenue today (Israel only)
      Order.aggregate([
        {
          $match: {
            ...israelMatch,
            createdAt: { $gte: todayStart },
            status: { $in: PAID_STATUSES },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: ifNullNumber("$pricing.total", 0) },
          },
        },
      ]),

      // Revenue last 7 days (Israel only)
      Order.aggregate([
        {
          $match: {
            ...israelMatch,
            createdAt: { $gte: sevenDaysAgo },
            status: { $in: PAID_STATUSES },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: ifNullNumber("$pricing.total", 0) },
          },
        },
      ]),

      // Revenue last 30 days (Israel only)
      Order.aggregate([
        {
          $match: {
            ...israelMatch,
            createdAt: { $gte: thirtyDaysAgo },
            status: { $in: PAID_STATUSES },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: ifNullNumber("$pricing.total", 0) },
          },
        },
      ]),

      // Orders today (Israel only)
      Order.countDocuments({
        ...israelMatch,
        createdAt: { $gte: todayStart },
      }),

      // Pending orders (Israel only)
      Order.countDocuments({
        ...israelMatch,
        status: { $in: PENDING_FULFILLMENT_STATUSES },
      }),

      // Open returns count (Israel only) using lookup to orders
      ReturnRequest.aggregate([
        { $match: { status: { $in: ["requested", "approved", "received", "refund_pending"] } } },
        {
          $lookup: {
            from: ORDERS_COLLECTION,
            localField: "orderId",
            foreignField: "_id",
            as: "order",
          },
        },
        { $unwind: "$order" },
        { $match: israelMatchForLookupOrder("order") },
        { $count: "count" },
      ]),

      // Low stock products (same as before)
      Product.countDocuments({
        isActive: true,
        isDeleted: { $ne: true },
        stock: { $lte: 5 },
      }),

      // Active users last 30 days (Israel only) - scalable
      Order.aggregate([
        {
          $match: {
            ...israelMatch,
            createdAt: { $gte: thirtyDaysAgo },
          },
        },
        { $group: { _id: "$userId" } },
        { $count: "count" },
      ]),

      // Top products last 30 days (Israel only) by units sold
      Order.aggregate([
        {
          $match: {
            ...israelMatch,
            createdAt: { $gte: thirtyDaysAgo },
            status: { $in: PAID_STATUSES },
          },
        },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.productId",
            title: { $first: "$items.titleHe" },
            titleAr: { $first: "$items.titleAr" },
            unitsSold: { $sum: ifNullNumber("$items.qty", 0) },
            revenue: {
              $sum: {
                $multiply: [
                  ifNullNumber("$items.unitPrice", 0),
                  ifNullNumber("$items.qty", 0),
                ],
              },
            },
          },
        },
        { $sort: { unitsSold: -1 } },
        { $limit: 10 },
        {
          $project: {
            _id: 0,
            productId: "$_id",
            title: 1,
            titleAr: 1,
            unitsSold: 1,
            revenue: 1,
          },
        },
      ]),

      // Latest orders (Israel only)
      Order.find(israelMatch)
        .sort({ createdAt: -1 })
        .limit(10)
        .select("_id orderNumber status paymentMethod pricing.total createdAt shipping.address.fullName")
        .lean(),

      // Latest returns (Israel only) with lookup to orders
      ReturnRequest.aggregate([
        { $sort: { requestedAt: -1 } },
        { $limit: 20 }, // take a bit more before filtering by israel to avoid empty results
        {
          $lookup: {
            from: ORDERS_COLLECTION,
            localField: "orderId",
            foreignField: "_id",
            as: "order",
          },
        },
        { $unwind: "$order" },
        { $match: israelMatchForLookupOrder("order") },
        { $limit: 10 },
        {
          $project: {
            _id: 1,
            orderId: 1,
            status: 1,
            reason: 1,
            requestedAt: 1,
            refundAmount: "$refund.amount",
          },
        },
      ]),
    ]);

    // Helpers for ReturnRequest -> Order lookup filtering
    function israelMatchForLookupOrder(orderFieldName) {
      // Build $or with prefixed paths: e.g. "order.shipping.address.countryCode"
      return {
        $or: COUNTRY_PATHS.map((path) => ({
          [`${orderFieldName}.${path}`]: ISRAEL_COUNTRY_CODE,
        })),
      };
    }

    // Extract values
    const revenueToday = revenueTodayResult[0]?.total || 0;
    const revenue7d = revenue7dResult[0]?.total || 0;
    const revenue30d = revenue30dResult[0]?.total || 0;

    const returnsOpen = returnsOpenCountResult[0]?.count || 0;
    const activeUsers30d = activeUsers30dResult[0]?.count || 0;

    // Map latest orders
    const mappedLatestOrders = (latestOrders || []).map((o) => ({
      id: o._id,
      orderNumber: o.orderNumber || "",
      status: o.status,
      paymentMethod: o.paymentMethod,
      total: o.pricing?.total || 0,
      customerName: o.shipping?.address?.fullName || "",
      createdAt: o.createdAt,
    }));

    // Map latest returns (already projected)
    const mappedLatestReturns = (latestReturnsAgg || []).map((r) => ({
      id: r._id,
      orderId: r.orderId,
      status: r.status,
      reason: r.reason,
      refundAmount: r.refundAmount || 0,
      requestedAt: r.requestedAt,
    }));

    const payload = {
      // Revenue KPIs
      revenueToday,
      revenue7d,
      revenue30d,

      // Order/Return counts (Israel only)
      ordersToday: ordersTodayCount,
      ordersPending: ordersPendingCount,
      returnsOpen,

      // Inventory
      lowStockCount,

      // User activity (Israel only)
      activeUsers30d,

      // Top products (Israel only)
      topProducts: topProductsResult,

      // Latest items (Israel only)
      latestOrders: mappedLatestOrders,
      latestReturns: mappedLatestReturns,

      // Metadata
      businessTimezone: BUSINESS_TZ,
      countryScope: ISRAEL_COUNTRY_CODE,
      generatedAt: now.toISOString(),
    };

    cacheSet(cacheKey, payload);
    return sendOk(res, payload);
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
