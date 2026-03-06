import express from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { RFQ } from "../models/RFQ.js";
import { Product } from "../models/Product.js";
import { SavedList } from "../models/SavedList.js";
import { SavedListItem } from "../models/SavedListItem.js";
import { SampleRequest } from "../models/SampleRequest.js";
import { RecurringOrder } from "../models/RecurringOrder.js";

const router = express.Router();

function normalizePhone(raw) {
  return String(raw || "").trim().replace(/[^\d+]/g, "");
}

/**
 * POST /api/v1/b2b/apply
 * Submit a B2B wholesale account application.
 * Requires authentication.
 */
const applySchema = z.object({
  body: z.object({
    businessName: z.string().trim().min(2).max(200),
    phone: z
      .string()
      .trim()
      .min(5)
      .max(40)
      .transform((v) => normalizePhone(v))
      .refine((v) => v.length >= 8 && v.length <= 20, {
        message: "Invalid phone number",
      }),
    message: z.string().trim().max(300).optional(),
  }),
});

router.post(
  "/apply",
  requireAuth(),
  validate(applySchema),
  async (req, res) => {
    try {
      const { businessName, phone, message } =
        req.validated?.body ?? req.body;

      const user = await User.findById(req.user._id);
      if (!user) {
        return res
          .status(404)
          .json({
            ok: false,
            error: { code: "NOT_FOUND", message: "User not found" },
          });
      }

      if (user.b2bApproved) {
        return res.json({ ok: true, data: { status: "already_approved" } });
      }

      user.accountType = "business";
      user.businessName = businessName;
      user.b2bPhone = phone;
      user.b2bMessage = message || "";
      user.b2bAppliedAt = new Date();

      await user.save();

      return res.json({ ok: true, data: { status: "pending_review" } });
    } catch (e) {
      return res
        .status(500)
        .json({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: e.message },
        });
    }
  },
);

/**
 * GET /api/v1/b2b/status
 * Check B2B application status.
 */
router.get("/status", requireAuth(), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      "accountType businessName b2bPhone b2bMessage wholesaleTier b2bApproved b2bAppliedAt b2bApprovedAt",
    );
    if (!user) {
      return res
        .status(404)
        .json({
          ok: false,
          error: { code: "NOT_FOUND", message: "User not found" },
        });
    }

    return res.json({
      ok: true,
      data: {
        accountType: user.accountType,
        businessName: user.businessName,
        b2bPhone: user.b2bPhone || "",
        b2bMessage: user.b2bMessage || "",
        wholesaleTier: user.wholesaleTier,
        b2bApproved: user.b2bApproved,
        b2bAppliedAt: user.b2bAppliedAt,
        b2bApprovedAt: user.b2bApprovedAt,
      },
    });
  } catch (e) {
    return res
      .status(500)
      .json({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: e.message },
      });
  }
});

/* ============================
   RFQ — Request for Quote
============================ */

const rfqCreateSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          qty: z.number().int().min(1).max(99999),
          note: z.string().max(500).optional(),
        }),
      )
      .min(1)
      .max(50),
    customerNote: z.string().max(2000).optional(),
  }),
});

/**
 * POST /api/v1/b2b/rfq
 * Submit an RFQ (B2B users only).
 */
router.post(
  "/rfq",
  requireAuth(),
  validate(rfqCreateSchema),
  async (req, res) => {
    try {
      const user = await User.findById(req.user._id).select("b2bApproved accountType").lean();
      if (!user?.b2bApproved) {
        return res.status(403).json({
          ok: false,
          error: { code: "NOT_B2B", message: "B2B account required" },
        });
      }

      const { items, customerNote } = req.validated?.body ?? req.body;

      const productIds = items.map((i) => i.productId);
      const products = await Product.find({ _id: { $in: productIds } })
        .select("_id titleHe titleAr title")
        .lean();
      const productMap = new Map(products.map((p) => [String(p._id), p]));

      const rfqItems = items.map((item) => {
        const product = productMap.get(item.productId);
        return {
          productId: item.productId,
          productTitle: product?.titleHe || product?.title || product?.titleAr || "",
          qty: item.qty,
          note: item.note || "",
        };
      });

      const rfq = new RFQ({
        userId: req.user._id,
        items: rfqItems,
        customerNote: customerNote || "",
      });

      await rfq.save();

      return res.status(201).json({ ok: true, data: rfq.toObject() });
    } catch (e) {
      return res
        .status(500)
        .json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
    }
  },
);

/**
 * GET /api/v1/b2b/rfq
 * List user's RFQs.
 */
router.get("/rfq", requireAuth(), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("b2bApproved").lean();
    if (!user?.b2bApproved) {
      return res.status(403).json({
        ok: false,
        error: { code: "NOT_B2B", message: "B2B account required" },
      });
    }

    const rfqs = await RFQ.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.json({ ok: true, data: rfqs });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/**
 * GET /api/v1/b2b/rfq/:id
 * Get a single RFQ.
 */
router.get("/rfq/:id", requireAuth(), async (req, res) => {
  try {
    const rfq = await RFQ.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).lean();

    if (!rfq) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "RFQ not found" },
      });
    }

    return res.json({ ok: true, data: rfq });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/* ============================
   Saved Lists (Requisition Lists)
============================ */

const MAX_SAVED_LISTS = 20;
const MAX_SAVED_LIST_ITEMS = 200;

const savedListItemSchema = z.object({
  productId: z.string().min(1),
  qty: z.number().int().min(1).max(9999),
  variantId: z.string().optional(),
});

const savedListCreateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    items: z
      .array(savedListItemSchema)
      .min(0)
      .max(MAX_SAVED_LIST_ITEMS)
      .optional()
      .default([]),
  }),
});

const savedListUpdateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    items: z
      .array(savedListItemSchema)
      .min(0)
      .max(MAX_SAVED_LIST_ITEMS)
      .optional(),
  }).refine((d) => d.name !== undefined || d.items !== undefined, {
    message: "At least name or items must be provided",
  }),
});

function clampSavedListQty(rawQty) {
  const qty = Number(rawQty || 1);
  if (!Number.isFinite(qty)) return 1;
  return Math.max(1, Math.min(9999, Math.floor(qty)));
}

function normalizeSavedListVariantId(rawVariantId) {
  return String(rawVariantId || "").trim();
}

function toObjectIdString(rawId) {
  const id = String(rawId || "").trim();
  return mongoose.Types.ObjectId.isValid(id) ? id : "";
}

async function requireB2BUser(req, res) {
  const user = await User.findById(req.user._id).select("b2bApproved").lean();
  if (!user?.b2bApproved) {
    res.status(403).json({
      ok: false,
      error: { code: "NOT_B2B", message: "B2B account required" },
    });
    return null;
  }
  return user;
}

async function sanitizeSavedListItems(itemsRaw = []) {
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) return [];

  const normalized = itemsRaw
    .map((it) => ({
      productId: toObjectIdString(it?.productId),
      qty: clampSavedListQty(it?.qty),
      variantId: normalizeSavedListVariantId(it?.variantId),
    }))
    .filter((it) => it.productId);

  if (!normalized.length) return [];

  const uniqueProductIds = [...new Set(normalized.map((it) => it.productId))];
  const products = await Product.find({ _id: { $in: uniqueProductIds } })
    .select("_id variants._id")
    .lean();
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  const dedup = new Map();
  for (const item of normalized) {
    const product = productMap.get(item.productId);
    if (!product) continue;

    const variants = Array.isArray(product.variants) ? product.variants : [];
    const hasVariants = variants.length > 0;

    let normalizedVariantId = "";
    if (hasVariants) {
      if (!item.variantId) continue;
      const variant = variants.find((v) => String(v?._id || "") === item.variantId);
      if (!variant) continue;
      normalizedVariantId = item.variantId;
    }

    const key = `${item.productId}:${normalizedVariantId}`;
    dedup.set(key, {
      productId: item.productId,
      variantId: normalizedVariantId,
      qty: item.qty,
    });
  }

  return Array.from(dedup.values());
}

async function fetchSavedListsByUser(userId, listIds = null) {
  const query = { userId };
  if (Array.isArray(listIds) && listIds.length > 0) {
    query._id = { $in: listIds };
  }

  const lists = await SavedList.find(query)
    .sort({ createdAt: -1 })
    .lean();

  if (!lists.length) return [];

  const ids = lists.map((l) => l._id);
  const items = await SavedListItem.find({ listId: { $in: ids } })
    .sort({ createdAt: 1 })
    .lean();

  const productIds = [...new Set(items.map((it) => String(it.productId || "")).filter(Boolean))];
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } })
      .select(
        "_id titleHe titleAr title slug images variants._id variants.variantKey variants.sku",
      )
      .lean()
    : [];

  const productMap = new Map(products.map((p) => [String(p._id), p]));
  const itemsByListId = new Map();
  for (const it of items) {
    const key = String(it.listId);
    if (!itemsByListId.has(key)) itemsByListId.set(key, []);
    itemsByListId.get(key).push(it);
  }

  return lists.map((list) => {
    const listItems = itemsByListId.get(String(list._id)) || [];
    const mappedItems = listItems.map((it) => {
      const product = productMap.get(String(it.productId));
      const variants = Array.isArray(product?.variants) ? product.variants : [];
      const variant = it.variantId
        ? variants.find((v) => String(v?._id || "") === String(it.variantId || ""))
        : null;

      return {
        productId: product
          ? {
            _id: product._id,
            titleHe: product.titleHe || "",
            titleAr: product.titleAr || "",
            title: product.title || "",
            slug: product.slug || "",
            images: Array.isArray(product.images) ? product.images : [],
          }
          : String(it.productId),
        qty: clampSavedListQty(it.qty),
        variantId: it.variantId || undefined,
        variantLabel: variant?.variantKey || variant?.sku || undefined,
      };
    });

    return {
      ...list,
      items: mappedItems,
    };
  });
}

const createSavedListHandler = async (req, res) => {
  try {
    const b2bUser = await requireB2BUser(req, res);
    if (!b2bUser) return;

    const { name, items } = req.validated?.body ?? req.body;
    const existing = await SavedList.countDocuments({ userId: req.user._id });
    if (existing >= MAX_SAVED_LISTS) {
      return res.status(400).json({
        ok: false,
        error: {
          code: "LIMIT_REACHED",
          message: `Max ${MAX_SAVED_LISTS} saved lists`,
        },
      });
    }

    const savedList = await SavedList.create({
      userId: req.user._id,
      name: String(name || "").trim(),
    });

    const normalizedItems = await sanitizeSavedListItems(items || []);
    if (normalizedItems.length > 0) {
      await SavedListItem.insertMany(
        normalizedItems.map((it) => ({
          listId: savedList._id,
          productId: it.productId,
          variantId: it.variantId || "",
          qty: it.qty,
        })),
      );
    }

    const [enriched] = await fetchSavedListsByUser(req.user._id, [savedList._id]);
    return res.status(201).json({
      ok: true,
      data: enriched || { ...savedList.toObject(), items: [] },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: e.message },
    });
  }
};

const listSavedListsHandler = async (req, res) => {
  try {
    const b2bUser = await requireB2BUser(req, res);
    if (!b2bUser) return;

    const lists = await fetchSavedListsByUser(req.user._id);
    return res.json({ ok: true, data: lists });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: e.message },
    });
  }
};

const updateSavedListHandler = async (req, res) => {
  try {
    const b2bUser = await requireB2BUser(req, res);
    if (!b2bUser) return;

    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ""))) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Saved list not found" },
      });
    }

    const savedList = await SavedList.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!savedList) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Saved list not found" },
      });
    }

    const { name, items } = req.validated?.body ?? req.body;
    if (name !== undefined) {
      savedList.name = String(name || "").trim();
    }
    await savedList.save();

    if (items !== undefined) {
      const normalizedItems = await sanitizeSavedListItems(items || []);
      await SavedListItem.deleteMany({ listId: savedList._id });
      if (normalizedItems.length > 0) {
        await SavedListItem.insertMany(
          normalizedItems.map((it) => ({
            listId: savedList._id,
            productId: it.productId,
            variantId: it.variantId || "",
            qty: it.qty,
          })),
        );
      }
    }

    const [enriched] = await fetchSavedListsByUser(req.user._id, [savedList._id]);
    return res.json({
      ok: true,
      data: enriched || { ...savedList.toObject(), items: [] },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: e.message },
    });
  }
};

const deleteSavedListHandler = async (req, res) => {
  try {
    const b2bUser = await requireB2BUser(req, res);
    if (!b2bUser) return;

    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ""))) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Saved list not found" },
      });
    }

    const result = await SavedList.deleteOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Saved list not found" },
      });
    }

    await SavedListItem.deleteMany({ listId: req.params.id });
    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: e.message },
    });
  }
};

/**
 * POST /api/v1/b2b/saved-lists/:id/add-to-cart
 * Add all items from a saved list to cart.
 */
const addSavedListToCartHandler = async (req, res) => {
  try {
    const b2bUser = await requireB2BUser(req, res);
    if (!b2bUser) return;

    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ""))) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Saved list not found" },
      });
    }

    const savedList = await SavedList.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).lean();
    if (!savedList) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Saved list not found" },
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "User not found" },
      });
    }

    const savedListItems = await SavedListItem.find({ listId: savedList._id }).lean();
    if (!savedListItems.length) {
      return res.json({
        ok: true,
        data: { addedCount: 0, cartSize: Array.isArray(user.cart) ? user.cart.length : 0 },
      });
    }

    const productIds = [...new Set(savedListItems.map((it) => String(it.productId || "")).filter(Boolean))];
    const products = await Product.find({ _id: { $in: productIds } })
      .select("_id isActive stock variants._id variants.stock")
      .lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    let addedCount = 0;
    for (const item of savedListItems) {
      const product = productMap.get(String(item.productId || ""));
      if (!product || !product.isActive) continue;

      const variants = Array.isArray(product.variants) ? product.variants : [];
      const hasVariants = variants.length > 0;
      let targetVariantId = "";
      let available = Number(product.stock || 0);

      if (hasVariants) {
        targetVariantId = String(item.variantId || "");
        if (!targetVariantId) continue;
        const variant = variants.find((v) => String(v?._id || "") === targetVariantId);
        if (!variant) continue;
        available = Number(variant.stock || 0);
      }

      if (available <= 0) continue;

      const safeQty = Math.max(1, Math.min(clampSavedListQty(item.qty), available, 999));

      const existingIdx = (user.cart || []).findIndex(
        (c) =>
          String(c.productId) === String(item.productId) &&
          String(c.variantId || "") === targetVariantId,
      );

      if (existingIdx >= 0) {
        user.cart[existingIdx].qty = safeQty;
      } else {
        user.cart.push({
          productId: item.productId,
          qty: safeQty,
          variantId: targetVariantId,
        });
      }
      addedCount++;
    }

    await user.save();
    return res.json({
      ok: true,
      data: { addedCount, cartSize: user.cart.length },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: e.message },
    });
  }
};

/**
 * POST /api/v1/b2b/saved-lists/from-order/:orderId
 * Create a saved list from an existing order.
 */
const createSavedListFromOrderHandler = async (req, res) => {
  try {
    const b2bUser = await requireB2BUser(req, res);
    if (!b2bUser) return;

    const existing = await SavedList.countDocuments({ userId: req.user._id });
    if (existing >= MAX_SAVED_LISTS) {
      return res.status(400).json({
        ok: false,
        error: {
          code: "LIMIT_REACHED",
          message: `Max ${MAX_SAVED_LISTS} saved lists`,
        },
      });
    }

    const { default: Order } = await import("../models/Order.js");
    const order = await Order.findOne({ _id: req.params.orderId, userId: req.user._id }).lean();
    if (!order) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Order not found" } });
    }

    const normalizedItems = await sanitizeSavedListItems((order.items || []).map((i) => ({
      productId: String(i.productId || ""),
      qty: i.qty || 1,
      variantId: i.variantId || "",
    })));

    const inputName = String(req.body?.name || "").trim();
    const name = inputName || `Order #${order.orderNumber || String(order._id).slice(-6)}`;

    const savedList = await SavedList.create({ userId: req.user._id, name });

    if (normalizedItems.length > 0) {
      await SavedListItem.insertMany(
        normalizedItems.map((it) => ({
          listId: savedList._id,
          productId: it.productId,
          variantId: it.variantId || "",
          qty: it.qty,
        })),
      );
    }

    const [enriched] = await fetchSavedListsByUser(req.user._id, [savedList._id]);
    return res.status(201).json({
      ok: true,
      data: enriched || { ...savedList.toObject(), items: [] },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: e.message },
    });
  }
};

// New canonical paths
router.post(
  "/saved-lists",
  requireAuth(),
  validate(savedListCreateSchema),
  createSavedListHandler,
);
router.get("/saved-lists", requireAuth(), listSavedListsHandler);
router.put(
  "/saved-lists/:id",
  requireAuth(),
  validate(savedListUpdateSchema),
  updateSavedListHandler,
);
router.delete("/saved-lists/:id", requireAuth(), deleteSavedListHandler);
router.post("/saved-lists/:id/add-to-cart", requireAuth(), addSavedListToCartHandler);
router.post("/saved-lists/from-order/:orderId", requireAuth(), createSavedListFromOrderHandler);

// Backward-compatible aliases (templates -> saved-lists)
router.post(
  "/templates",
  requireAuth(),
  validate(savedListCreateSchema),
  createSavedListHandler,
);
router.get("/templates", requireAuth(), listSavedListsHandler);
router.put(
  "/templates/:id",
  requireAuth(),
  validate(savedListUpdateSchema),
  updateSavedListHandler,
);
router.delete("/templates/:id", requireAuth(), deleteSavedListHandler);
router.post("/templates/:id/add-to-cart", requireAuth(), addSavedListToCartHandler);
router.post("/templates/from-order/:orderId", requireAuth(), createSavedListFromOrderHandler);

/* ============================
   Sample Requests
============================ */

const sampleCreateSchema = z.object({
  body: z.object({
    items: z
      .array(z.object({ productId: z.string().min(1) }))
      .min(1)
      .max(5),
    note: z.string().max(1000).optional(),
  }),
});

router.post("/samples", requireAuth(), validate(sampleCreateSchema), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("b2bApproved").lean();
    if (!user?.b2bApproved) {
      return res.status(403).json({ ok: false, error: { code: "NOT_B2B", message: "B2B account required" } });
    }

    const { items, note } = req.validated?.body ?? req.body;

    // Check for recent requests (max 1 per 7 days)
    const recent = await SampleRequest.findOne({
      userId: req.user._id,
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    }).lean();
    if (recent) {
      return res.status(429).json({ ok: false, error: { code: "TOO_FREQUENT", message: "Max 1 sample request per week" } });
    }

    const productIds = items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds } })
      .select("_id titleHe titleAr title")
      .lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const sampleItems = items.map((item) => {
      const product = productMap.get(item.productId);
      return {
        productId: item.productId,
        productTitle: product?.titleHe || product?.title || product?.titleAr || "",
      };
    });

    const sample = await SampleRequest.create({
      userId: req.user._id,
      items: sampleItems,
      note: note || "",
    });

    return res.status(201).json({ ok: true, data: sample.toObject() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

router.get("/samples", requireAuth(), async (req, res) => {
  try {
    const samples = await SampleRequest.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    return res.json({ ok: true, data: samples });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/* ============================
   Recurring Orders
============================ */

function computeNextRun(frequency) {
  const now = new Date();
  const ms = {
    weekly: 7 * 24 * 60 * 60 * 1000,
    biweekly: 14 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000,
    bimonthly: 60 * 24 * 60 * 60 * 1000,
    quarterly: 90 * 24 * 60 * 60 * 1000,
  };
  return new Date(now.getTime() + (ms[frequency] || ms.monthly));
}

const recurringCreateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    items: z
      .array(z.object({
        productId: z.string().min(1),
        qty: z.number().int().min(1).max(9999),
        variantId: z.string().optional(),
      }))
      .min(1)
      .max(100),
    frequency: z.enum(["weekly", "biweekly", "monthly", "bimonthly", "quarterly"]),
    shippingMode: z.enum(["DELIVERY", "PICKUP_POINT", "STORE_PICKUP"]).optional(),
    deliveryAreaId: z.string().optional(),
    pickupPointId: z.string().optional(),
  }),
});

router.post("/recurring", requireAuth(), validate(recurringCreateSchema), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("b2bApproved").lean();
    if (!user?.b2bApproved) {
      return res.status(403).json({ ok: false, error: { code: "NOT_B2B", message: "B2B account required" } });
    }

    const { name, items, frequency, shippingMode, deliveryAreaId, pickupPointId } = req.validated?.body ?? req.body;

    const existing = await RecurringOrder.countDocuments({ userId: req.user._id, isActive: true });
    if (existing >= 10) {
      return res.status(400).json({ ok: false, error: { code: "LIMIT_REACHED", message: "Max 10 active recurring orders" } });
    }

    const recurring = await RecurringOrder.create({
      userId: req.user._id,
      name,
      items,
      frequency,
      nextRunAt: computeNextRun(frequency),
      shippingMode: shippingMode || "DELIVERY",
      deliveryAreaId: deliveryAreaId || "",
      pickupPointId: pickupPointId || "",
    });

    return res.status(201).json({ ok: true, data: recurring.toObject() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

router.get("/recurring", requireAuth(), async (req, res) => {
  try {
    const items = await RecurringOrder.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ ok: true, data: items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

router.patch("/recurring/:id", requireAuth(), async (req, res) => {
  try {
    const recurring = await RecurringOrder.findOne({ _id: req.params.id, userId: req.user._id });
    if (!recurring) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } });
    }

    if (req.body.isActive !== undefined) recurring.isActive = Boolean(req.body.isActive);
    if (req.body.frequency) {
      recurring.frequency = req.body.frequency;
      recurring.nextRunAt = computeNextRun(req.body.frequency);
    }

    await recurring.save();
    return res.json({ ok: true, data: recurring.toObject() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

router.delete("/recurring/:id", requireAuth(), async (req, res) => {
  try {
    const result = await RecurringOrder.deleteOne({ _id: req.params.id, userId: req.user._id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } });
    }
    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/* ============================
   GET /api/v1/b2b/my-custom-pricing
   Returns the authenticated user's custom price list
============================ */
router.get("/my-custom-pricing", requireAuth(), async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select("customPricing b2bApproved")
      .lean();

    if (!user?.b2bApproved) {
      return res.json({ customPricing: [] });
    }

    const priceMap = {};
    for (const cp of user.customPricing || []) {
      priceMap[String(cp.productId)] = cp.price;
    }

    return res.json({ customPricing: priceMap });
  } catch (e) {
    return res.status(500).json({ error: "INTERNAL", message: e.message });
  }
});

export default router;
