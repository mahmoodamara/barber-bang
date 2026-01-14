import { Order } from "../models/Order.js";
import { parsePagination } from "../utils/paginate.js";
import { applyQueryBudget } from "../utils/queryBudget.js";

export async function listMyOrders({ userId, page, limit }) {
  const p = parsePagination({ page, limit }, { maxLimit: 50, defaultLimit: 20 });

  const [items, total] = await Promise.all([
    applyQueryBudget(
      Order.find({ userId })
        .sort({ createdAt: -1 })
        .skip(p.skip)
        .limit(p.limit)
        .lean(),
    ),
    applyQueryBudget(Order.countDocuments({ userId })),
  ]);

  return { items, total, page: p.page, limit: p.limit };
}

export async function getOrderForUser({ userId, orderId }) {
  const order = await applyQueryBudget(
    Order.findOne({ _id: orderId, userId }).lean(),
  );
  if (!order) {
    const err = new Error("ORDER_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }
  return order;
}
