// src/routes/admin.dashboard.routes.js
import express from "express";
import { createHash } from "node:crypto";
import { DateTime } from "luxon";

import { Order } from "../models/Order.js";
import { ReturnRequest } from "../models/ReturnRequest.js";
import { Product } from "../models/Product.js";
import { User } from "../models/User.js";
import { RFQ } from "../models/RFQ.js";

import { requireAuth, requireAnyPermission, PERMISSIONS } from "../middleware/auth.js";
import { sendOk, sendError } from "../utils/response.js";

/** Allowed period values for main KPI comparison (current vs previous period). */
const ALLOWED_PERIODS = new Set(["7d", "30d", "90d"]);
const DEFAULT_PERIOD = "30d";
const DEFAULT_LATEST_LIMIT = 10;
const MAX_LATEST_LIMIT = 50;
const DASHBOARD_CACHE_MAX_AGE_SEC = 20;

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
 * Order model may not define these; if missing, we treat orders as in-scope (single-country store).
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
 * Base match for dashboard orders: Israel-only when country is set, else all orders.
 * Order schema (Order.js) does not define shipping.address.countryCode, so existing
 * orders have no country set — we include them so revenue/counts are correct.
 * When you add countryCode to Order and set it in checkout, orders will filter by IL.
 */
function ordersScopeMatch() {
  const isIsrael = COUNTRY_PATHS.map((path) => ({ [path]: ISRAEL_COUNTRY_CODE }));
  const noCountrySet = COUNTRY_PATHS.map((path) => ({ [path]: { $exists: false } }));
  return {
    $or: [
      ...isIsrael,
      { $and: noCountrySet },
    ],
  };
}

/**
 * Safe numeric sum field fallback
 */
function ifNullNumber(path, fallback = 0) {
  return { $ifNull: [path, fallback] };
}

/**
 * Parse period query (e.g. "30d") to number of days. Default 30.
 */
function parsePeriodDays(period) {
  const p = String(period || "").trim().toLowerCase();
  if (!ALLOWED_PERIODS.has(p)) return 30; // default for "30d"
  return parseInt(p.replace(/\D/g, ""), 10) || 30;
}

/**
 * Current period starts at (now - periodDays) and runs until now (includes today).
 * Previous period is the same length ending exactly when current starts.
 */
function getPeriodBounds(periodDays, tz = BUSINESS_TZ) {
  const now = DateTime.now().setZone(tz);
  const todayStart = now.startOf("day").toJSDate();
  const periodStart = now.minus({ days: periodDays }).startOf("day").toJSDate();
  const previousPeriodEnd = periodStart;
  const previousPeriodStart = DateTime.fromJSDate(previousPeriodEnd, { zone: tz })
    .minus({ days: periodDays })
    .startOf("day")
    .toJSDate();
  return {
    periodStart,
    periodEnd: todayStart, // for display only; current period query uses $gte periodStart (no upper bound)
    previousPeriodStart,
    previousPeriodEnd,
  };
}

/**
 * Percent change: ((current - previous) / previous) * 100. null if previous is 0.
 */
function percentChange(current, previous) {
  if (previous == null || previous === 0) return null;
  const change = ((Number(current) - Number(previous)) / Number(previous)) * 100;
  return Math.round(change * 100) / 100;
}

/**
 * Clamp limit for latest orders/returns (1..MAX_LATEST_LIMIT).
 */
function parseLatestLimit(value) {
  const n = parseInt(String(value || ""), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LATEST_LIMIT;
  return Math.min(n, MAX_LATEST_LIMIT);
}

/** Match for ReturnRequest $lookup: include orders that are in scope (Israel or no country set). */
function scopeMatchForLookupOrder(orderFieldName) {
  const isIsrael = COUNTRY_PATHS.map((path) => ({
    [`${orderFieldName}.${path}`]: ISRAEL_COUNTRY_CODE,
  }));
  const noCountrySet = COUNTRY_PATHS.map((path) => ({
    [`${orderFieldName}.${path}`]: { $exists: false },
  }));
  return {
    $or: [...isIsrael, { $and: noCountrySet }],
  };
}

/* ============================
   GET /api/v1/admin/dashboard
   KPI Dashboard (Israel). Supports period comparison and Cache-Control/ETag.
   Query: period=7d|30d|90d (default 30d), limit=1..50 (latest lists, default 10).
============================ */

router.get("/", async (req, res) => {
  try {
    const periodParam = String(req.query?.period || DEFAULT_PERIOD).trim().toLowerCase();
    const period = ALLOWED_PERIODS.has(periodParam) ? periodParam : DEFAULT_PERIOD;
    const periodDays = parsePeriodDays(period);
    const latestLimit = parseLatestLimit(req.query?.limit);

    const cacheKey = `admin:dashboard:israel:v2:${period}:${latestLimit}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      if (setDashboardHeaders(req, res, cached)) return;
      return sendOk(res, cached);
    }

    const now = new Date();
    const todayStart = startOfDayInTZ(now, BUSINESS_TZ);
    const sevenDaysAgo = daysAgoStartInTZ(7, BUSINESS_TZ);
    const thirtyDaysAgo = daysAgoStartInTZ(30, BUSINESS_TZ);
    const bounds = getPeriodBounds(periodDays, BUSINESS_TZ);
    const { periodStart, periodEnd, previousPeriodStart, previousPeriodEnd } = bounds;

    const ordersMatch = ordersScopeMatch();
    const ORDERS_COLLECTION = Order.collection.name;

    const [
      revenueTodayResult,
      revenue7dResult,
      revenue30dResult,
      revenuePeriodResult,
      revenuePreviousResult,
      ordersTodayCount,
      ordersPeriodCount,
      ordersPreviousCount,
      ordersPendingCount,
      returnsOpenCountResult,
      lowStockCount,
      activeUsersResult,
      topProductsResult,
      latestOrders,
      latestReturnsAgg,
    ] = await Promise.all([
      Order.aggregate([
        {
          $match: {
            ...ordersMatch,
            createdAt: { $gte: todayStart },
            status: { $in: PAID_STATUSES },
          },
        },
        { $group: { _id: null, total: { $sum: ifNullNumber("$pricing.total", 0) } } },
      ]),
      Order.aggregate([
        {
          $match: {
            ...ordersMatch,
            createdAt: { $gte: sevenDaysAgo },
            status: { $in: PAID_STATUSES },
          },
        },
        { $group: { _id: null, total: { $sum: ifNullNumber("$pricing.total", 0) } } },
      ]),
      Order.aggregate([
        {
          $match: {
            ...ordersMatch,
            createdAt: { $gte: thirtyDaysAgo },
            status: { $in: PAID_STATUSES },
          },
        },
        { $group: { _id: null, total: { $sum: ifNullNumber("$pricing.total", 0) } } },
      ]),
      Order.aggregate([
        {
          $match: {
            ...ordersMatch,
            createdAt: { $gte: periodStart },
            status: { $in: PAID_STATUSES },
          },
        },
        { $group: { _id: null, total: { $sum: ifNullNumber("$pricing.total", 0) } } },
      ]),
      Order.aggregate([
        {
          $match: {
            ...ordersMatch,
            createdAt: { $gte: previousPeriodStart, $lt: previousPeriodEnd },
            status: { $in: PAID_STATUSES },
          },
        },
        { $group: { _id: null, total: { $sum: ifNullNumber("$pricing.total", 0) } } },
      ]),
      Order.countDocuments({ ...ordersMatch, createdAt: { $gte: todayStart } }),
      Order.countDocuments({
        ...ordersMatch,
        createdAt: { $gte: periodStart },
      }),
      Order.countDocuments({
        ...ordersMatch,
        createdAt: { $gte: previousPeriodStart, $lt: previousPeriodEnd },
      }),
      Order.countDocuments({
        ...ordersMatch,
        status: { $in: PENDING_FULFILLMENT_STATUSES },
      }),
      ReturnRequest.aggregate([
        { $match: { status: { $in: ["requested", "approved", "received", "refund_pending"] } } },
        { $lookup: { from: ORDERS_COLLECTION, localField: "orderId", foreignField: "_id", as: "order" } },
        { $unwind: "$order" },
        { $match: scopeMatchForLookupOrder("order") },
        { $count: "count" },
      ]),
      Product.countDocuments({
        isActive: true,
        isDeleted: { $ne: true },
        stock: { $lte: 5 },
      }),
      Order.aggregate([
        { $match: { ...ordersMatch, createdAt: { $gte: periodStart } } },
        { $group: { _id: "$userId" } },
        { $count: "count" },
      ]),
      Order.aggregate([
        {
          $match: {
            ...ordersMatch,
            createdAt: { $gte: periodStart },
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
                $multiply: [ifNullNumber("$items.unitPrice", 0), ifNullNumber("$items.qty", 0)],
              },
            },
          },
        },
        { $sort: { unitsSold: -1 } },
        { $limit: 10 },
        { $project: { _id: 0, productId: "$_id", title: 1, titleAr: 1, unitsSold: 1, revenue: 1 } },
      ]),
      Order.find(ordersMatch)
        .sort({ createdAt: -1 })
        .limit(latestLimit)
        .select("_id orderNumber status paymentMethod pricing.total createdAt shipping.address.fullName")
        .lean(),
      ReturnRequest.aggregate([
        { $sort: { requestedAt: -1 } },
        { $limit: Math.min(latestLimit + 10, 60) },
        { $lookup: { from: ORDERS_COLLECTION, localField: "orderId", foreignField: "_id", as: "order" } },
        { $unwind: "$order" },
        { $match: scopeMatchForLookupOrder("order") },
        { $limit: latestLimit },
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

    const revenueToday = revenueTodayResult[0]?.total || 0;
    const revenue7d = revenue7dResult[0]?.total || 0;
    const revenue30d = revenue30dResult[0]?.total || 0;
    const revenuePeriod = revenuePeriodResult[0]?.total || 0;
    const revenuePrevious = revenuePreviousResult[0]?.total || 0;
    const ordersPeriod = ordersPeriodCount;
    const ordersPrevious = ordersPreviousCount;
    const returnsOpen = returnsOpenCountResult[0]?.count || 0;
    const activeUsers = activeUsersResult[0]?.count || 0;

    const payload = {
      // Today snapshot + fixed 7d/30d (backward compatible)
      revenueToday,
      revenue7d,
      revenue30d,
      ordersToday: ordersTodayCount,
      ordersPending: ordersPendingCount,
      returnsOpen,
      lowStockCount,

      // Period-based KPIs (current + previous + % change — like global dashboards)
      period,
      periodStart: bounds.periodStart.toISOString(),
      periodEnd: bounds.periodEnd.toISOString(),
      previousPeriodStart: bounds.previousPeriodStart.toISOString(),
      previousPeriodEnd: bounds.previousPeriodEnd.toISOString(),
      revenue: revenuePeriod,
      revenuePrevious,
      revenuePercentChange: percentChange(revenuePeriod, revenuePrevious),
      ordersCount: ordersPeriod,
      ordersCountPrevious: ordersPrevious,
      ordersCountPercentChange: percentChange(ordersPeriod, ordersPrevious),

      activeUsers,
      topProducts: topProductsResult,
      latestOrders: (latestOrders || []).map((o) => ({
        id: o._id,
        orderNumber: o.orderNumber || "",
        status: o.status,
        paymentMethod: o.paymentMethod,
        total: o.pricing?.total || 0,
        customerName: o.shipping?.address?.fullName || "",
        createdAt: o.createdAt,
      })),
      latestReturns: (latestReturnsAgg || []).map((r) => ({
        id: r._id,
        orderId: r.orderId,
        status: r.status,
        reason: r.reason,
        refundAmount: r.refundAmount || 0,
        requestedAt: r.requestedAt,
      })),

      businessTimezone: BUSINESS_TZ,
      countryScope: ISRAEL_COUNTRY_CODE,
      generatedAt: now.toISOString(),
    };

    cacheSet(cacheKey, payload);
    if (setDashboardHeaders(req, res, payload)) return;
    return sendOk(res, payload);
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * Set Cache-Control and ETag; if client sent matching If-None-Match, send 304 and return true.
 */
function setDashboardHeaders(req, res, payload) {
  res.setHeader("Cache-Control", `private, max-age=${DASHBOARD_CACHE_MAX_AGE_SEC}`);
  const etag = createHash("md5").update(JSON.stringify(payload)).digest("hex");
  const etagHeader = `"${etag}"`;
  res.setHeader("ETag", etagHeader);
  const ifNoneMatch = (req.headers["if-none-match"] || "").trim();
  if (ifNoneMatch === etagHeader || ifNoneMatch === "*") {
    res.status(304).end();
    return true;
  }
  return false;
}

/* ============================
   GET /api/admin/dashboard/b2b
   B2B Analytics
============================ */

router.get("/b2b", async (req, res) => {
  try {
    const [
      totalB2BUsers,
      pendingApplications,
      approvedUsers,
      tierCounts,
      b2bOrders,
      rfqCounts,
    ] = await Promise.all([
      User.countDocuments({ accountType: "business" }),
      User.countDocuments({ b2bAppliedAt: { $ne: null }, b2bApproved: false, b2bRejectedAt: null }),
      User.countDocuments({ b2bApproved: true }),
      User.aggregate([
        { $match: { b2bApproved: true } },
        { $group: { _id: "$wholesaleTier", count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { isB2B: true } },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalRevenue: { $sum: "$pricing.total" },
            avgOrderValue: { $avg: "$pricing.total" },
          },
        },
      ]),
      RFQ.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const tierMap = {};
    for (const t of tierCounts) {
      tierMap[t._id || "none"] = t.count;
    }

    const rfqMap = {};
    for (const r of rfqCounts) {
      rfqMap[r._id] = r.count;
    }

    const orderStats = b2bOrders[0] || { totalOrders: 0, totalRevenue: 0, avgOrderValue: 0 };

    // Top B2B customers by revenue
    const topCustomers = await Order.aggregate([
      { $match: { isB2B: true } },
      {
        $group: {
          _id: "$userId",
          totalSpent: { $sum: "$pricing.total" },
          orderCount: { $sum: 1 },
        },
      },
      { $sort: { totalSpent: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          userId: "$_id",
          businessName: "$user.businessName",
          email: "$user.email",
          wholesaleTier: "$user.wholesaleTier",
          totalSpent: 1,
          orderCount: 1,
        },
      },
    ]);

    return res.json({
      ok: true,
      data: {
        users: {
          total: totalB2BUsers,
          pending: pendingApplications,
          approved: approvedUsers,
          tiers: tierMap,
        },
        orders: {
          total: orderStats.totalOrders,
          revenue: Number(orderStats.totalRevenue).toFixed(2),
          avgOrderValue: Number(orderStats.avgOrderValue).toFixed(2),
        },
        rfqs: rfqMap,
        topCustomers,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

export default router;
