// src/controllers/webhooks.controller.js
import Stripe from "stripe";
import { ENV } from "../utils/env.js";
import { StripeEvent } from "../models/StripeEvent.js";
import { finalizePaidOrder } from "../services/payment.service.js";
import { logger } from "../utils/logger.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";

const stripe = new Stripe(ENV.STRIPE_SECRET_KEY, {
  maxNetworkRetries: 2,
  timeout: 20_000,
});

/**
 * Stripe webhook handler
 * - Requires req.body as raw Buffer (express.raw on the route)
 * - Persists StripeEvent for idempotency + observability
 * - ACKs 200 only when we do NOT want Stripe to retry
 */
export async function handleStripeWebhook(req, res) {
  // Must be a Buffer from express.raw()
  if (!Buffer.isBuffer(req.body)) {
    logger.error(
      { bodyType: typeof req.body, isBuffer: Buffer.isBuffer(req.body) },
      "Stripe webhook body is not a Buffer",
    );
    return res.status(400).send("Invalid body");
  }

  /* -------------------------------------------------- */
  /* Verify signature                                   */
  /* -------------------------------------------------- */
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], ENV.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    logger.warn({ err: String(e?.message || e) }, "Stripe webhook signature verification failed");
    return res.status(400).send("Invalid signature");
  }

  /* -------------------------------------------------- */
  /* Idempotency record                                 */
  /* -------------------------------------------------- */
  try {
    await StripeEvent.create({
      eventId: event.id,
      type: event.type,
      created: typeof event.created === "number" ? event.created : undefined,
      status: "received",
    });
  } catch (e) {
    // Mongo duplicate key -> event already exists
    if (e?.code === 11000) {
      const existing = await StripeEvent.findOne({ eventId: event.id }).lean();

      // If already processed, ACK immediately (idempotent)
      if (existing?.status === "processed") {
        logger.info({ eventId: event.id, type: event.type }, "Duplicate Stripe event already processed");
        return res.json({ ok: true, received: true });
      }

      // If not processed (received/failed), allow re-processing so Stripe retries can recover from transient failures
      logger.warn(
        { eventId: event.id, type: event.type, status: existing?.status },
        "Duplicate Stripe event will be reprocessed",
      );
    } else {
      logger.error({ err: String(e?.message || e) }, "StripeEvent.create failed");
      return res.status(500).json({ ok: false, received: false });
    }
  }

  /* -------------------------------------------------- */
  /* Dispatch                                           */
  /* -------------------------------------------------- */

  // Audit log: received webhook event
  await logAuditSuccess(req, AuditActions.STRIPE_WEBHOOK_RECEIVED, {
    type: "StripeEvent",
    id: event.id,
  }, { message: `Stripe event: ${event.type}` });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        await finalizePaidOrder(session);

        // Audit log: order finalized
        await logAuditSuccess(req, AuditActions.STRIPE_CHECKOUT_COMPLETED, {
          type: "StripeEvent",
          id: event.id,
        }, { message: `Checkout completed, session: ${session.id}` });
        break;
      }

      default: {
        // Ignore unhandled events (ACK so Stripe doesn't retry forever)
        logger.info({ eventId: event.id, type: event.type }, "Unhandled Stripe event (ignored)");
        break;
      }
    }

    await StripeEvent.updateOne(
      { eventId: event.id },
      { $set: { status: "processed", processedAt: new Date(), lastError: null } },
    );

    return res.json({ ok: true, received: true });
  } catch (e) {
    const errMsg = String(e?.message || e);

    await StripeEvent.updateOne(
      { eventId: event.id },
      { $set: { status: "failed", lastError: errMsg, failedAt: new Date() } },
    );

    // Audit log: webhook processing failed
    await logAuditFail(req, AuditActions.STRIPE_WEBHOOK_RECEIVED, {
      type: "StripeEvent",
      id: event.id,
    }, { message: errMsg, code: "WEBHOOK_PROCESSING_FAILED" });

    logger.error({ eventId: event.id, type: event.type, err: errMsg }, "Webhook processing failed");
    // Stripe retries on 5xx
    return res.status(500).json({ ok: false, received: false });
  }
}

// Backward-compatible alias (if any internal code references stripeWebhook)
export const stripeWebhook = handleStripeWebhook;
