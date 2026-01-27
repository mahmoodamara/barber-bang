// src/routes/admin.dashboard.routes.js
import express from "express";
import mongoose from "mongoose";

import { Order } from "../models/Order.js";
import { ReturnRequest } from "../models/ReturnRequest.js";
import { Product } from "../models/Product.js";
import { User } from "../models/User.js";
import { requireAuth, requireAnyPermission, PERMISSIONS } from "../middleware/auth.js";
import { sendOk, sendError } from "../utils/response.js";

const router = express.Router();

// Auth + RBAC: Admin always allowed, Staff needs at least one of these permissions
router.use(requireAuth());
router.use(
  requireAnyPermission(
    PERMISSIONS.ORDERS_WRITE,
    PERMISSIONS.PRODUCTS_WRITE,
    PERMISSIONS.SETTINGS_WRITE
  )
);

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

/**
 * Get start of day in UTC
 */
function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Get date N days ago
 */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return startOfDay(d);
}

/* ============================
   GET /api/v1/admin/dashboard
   KPI Dashboard endpoint
============================ */

router.get("/", async (req, res) => {
  try {
    const now = new Date();
    const todayStart = startOfDay(now);
    const sevenDaysAgo = daysAgo(7);
    const thirtyDaysAgo = daysAgo(30);

    // Paid order statuses for revenue calculation
    const paidStatuses = [
      "paid",
      "payment_received",
      "stock_confirmed",
      "confirmed",
      "shipped",
      "delivered",
      "partially_refunded",
    ];

    // Run all queries in parallel for efficiency
    const [
      revenueTodayResult,
      revenue7dResult,
      revenue30dResult,
      ordersTodayCount,
      ordersPendingCount,
      returnsOpenCount,
      lowStockCount,
      activeUsers30dCount,
      topProductsResult,
      latestOrders,
      latestReturns,
    ] = await Promise.all([
      // Revenue today
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: todayStart },
            status: { $in: paidStatuses },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$pricing.total" },
          },
        },
      ]),

      // Revenue last 7 days
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: sevenDaysAgo },
            status: { $in: paidStatuses },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$pricing.total" },
          },
        },
      ]),

      // Revenue last 30 days
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: thirtyDaysAgo },
            status: { $in: paidStatuses },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$pricing.total" },
          },
        },
      ]),

      // Orders today
      Order.countDocuments({ createdAt: { $gte: todayStart } }),

      // Pending orders (awaiting fulfillment)
      Order.countDocuments({
        status: {
          $in: ["pending_payment", "pending_cod", "cod_pending_approval", "paid", "payment_received", "stock_confirmed", "confirmed"],
        },
      }),

      // Open returns (not closed/refunded)
      ReturnRequest.countDocuments({
        status: { $in: ["requested", "approved", "received", "refund_pending"] },
      }),

      // Low stock products (stock <= 5, active, not deleted)
      Product.countDocuments({
        isActive: true,
        isDeleted: { $ne: true },
        stock: { $lte: 5 },
      }),

      // Active users in last 30 days (users with orders)
      Order.distinct("userId", { createdAt: { $gte: thirtyDaysAgo } }).then((ids) => ids.length),

      // Top products last 30 days (by units sold)
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: thirtyDaysAgo },
            status: { $in: paidStatuses },
          },
        },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.productId",
            title: { $first: "$items.titleHe" },
            titleAr: { $first: "$items.titleAr" },
            unitsSold: { $sum: "$items.qty" },
            revenue: { $sum: { $multiply: ["$items.unitPrice", "$items.qty"] } },
          },
        },
        { $sort: { unitsSold: -1 } },
        { $limit: 10 },
        {
          $project: {
            productId: "$_id",
            title: 1,
            titleAr: 1,
            unitsSold: 1,
            revenue: 1,
            _id: 0,
          },
        },
      ]),

      // Latest orders (limit 10) - lightweight projection
      Order.find({})
        .sort({ createdAt: -1 })
        .limit(10)
        .select("_id orderNumber status paymentMethod pricing.total createdAt shipping.address.fullName")
        .lean(),

      // Latest returns (limit 10)
      ReturnRequest.find({})
        .sort({ requestedAt: -1 })
        .limit(10)
        .select("_id orderId status reason requestedAt refund.amount")
        .lean(),
    ]);

    // Extract revenue values (default to 0 if no results)
    const revenueToday = revenueTodayResult[0]?.total || 0;
    const revenue7d = revenue7dResult[0]?.total || 0;
    const revenue30d = revenue30dResult[0]?.total || 0;

    // Map latest orders for response
    const mappedLatestOrders = latestOrders.map((o) => ({
      id: o._id,
      orderNumber: o.orderNumber || "",
      status: o.status,
      paymentMethod: o.paymentMethod,
      total: o.pricing?.total || 0,
      customerName: o.shipping?.address?.fullName || "",
      createdAt: o.createdAt,
    }));

    // Map latest returns for response
    const mappedLatestReturns = latestReturns.map((r) => ({
      id: r._id,
      orderId: r.orderId,
      status: r.status,
      reason: r.reason,
      refundAmount: r.refund?.amount || 0,
      requestedAt: r.requestedAt,
    }));

    return sendOk(res, {
      // Revenue KPIs (ILS major)
      revenueToday,
      revenue7d,
      revenue30d,

      // Order/Return counts
      ordersToday: ordersTodayCount,
      ordersPending: ordersPendingCount,
      returnsOpen: returnsOpenCount,

      // Inventory
      lowStockCount,

      // User activity
      activeUsers30d: activeUsers30dCount,

      // Top products
      topProducts: topProductsResult,

      // Latest items
      latestOrders: mappedLatestOrders,
      latestReturns: mappedLatestReturns,

      // Timestamp for cache invalidation
      generatedAt: now.toISOString(),
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
