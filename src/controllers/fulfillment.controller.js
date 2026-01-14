import { logAuditFail, logAuditSuccess, AuditActions } from "../services/audit.service.js";
import { adminAddOrderFulfillmentEvent, getMyOrderFulfillment } from "../services/fulfillment.service.js";
import { enqueueOrderNotification } from "../services/notification.service.js";

export async function getFulfillmentTimeline(req, res) {
  const out = await getMyOrderFulfillment({
    orderId: req.params.id,
    userId: req.auth.userId,
  });
  res.json({ ok: true, timeline: out });
}

export async function adminAddFulfillmentEvent(req, res) {
  try {
    const out = await adminAddOrderFulfillmentEvent(
      req.params.id,
      req.validated?.body ?? req.body,
      {
        requestId: req.id,
        actorId: req.auth?.userId || null,
        roles: req.auth?.roles || [],
      },
    );

    const events = Array.isArray(out?.fulfillment?.events) ? out.fulfillment.events : [];
    const lastType = events.length ? String(events[events.length - 1]?.type || "") : "";
    if (lastType === "shipped" || lastType === "delivered") {
      void enqueueOrderNotification({
        orderId: req.params.id,
        event: lastType === "shipped" ? "order_shipped" : "order_delivered",
        dedupeKey: `notify:${lastType}:${String(req.params.id)}:${String(events[events.length - 1]?.at || "")}`,
        meta: { source: "admin_fulfillment" },
      }).catch(() => {});
    }

    await logAuditSuccess(req, AuditActions.ADMIN_ORDER_FULFILLMENT_EVENT_ADD, {
      type: "Order",
      id: req.params.id,
    });

    res.json({ ok: true, timeline: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_ORDER_FULFILLMENT_EVENT_ADD, {
      type: "Order",
      id: req.params.id,
    }, err);
    throw err;
  }
}
