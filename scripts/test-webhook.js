/**
 * Test script: sends a signed checkout.session.completed webhook to the local server.
 * Usage: node scripts/test-webhook.js <orderId>
 *
 * Reads STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, MONGO_URI from .env
 */
import "dotenv/config";
import Stripe from "stripe";
import http from "node:http";
import mongoose from "mongoose";

const orderId = process.argv[2];
if (!orderId) {
  console.error("Usage: node scripts/test-webhook.js <orderId>");
  process.exit(1);
}

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const PORT = Number(process.env.PORT) || 4000;

if (!WEBHOOK_SECRET || !STRIPE_SECRET || !MONGO_URI) {
  console.error(
    "STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, MONGO_URI must be set in .env",
  );
  process.exit(1);
}

// Connect to Mongo to fetch the order's actual totalMinor
await mongoose.connect(MONGO_URI);

const Order = mongoose.model(
  "Order",
  new mongoose.Schema(
    {
      status: String,
      paymentMethod: String,
      pricing: mongoose.Schema.Types.Mixed,
      confirmationEmailSentAt: Date,
    },
    { strict: false },
  ),
);

const order = await Order.findById(orderId).lean();
if (!order) {
  console.error(`Order ${orderId} not found`);
  await mongoose.disconnect();
  process.exit(1);
}

console.log(
  `Order found: #${order.orderNumber} | status=${order.status} | paymentMethod=${order.paymentMethod}`,
);
console.log(
  `totalMinor=${order.pricing?.totalMinor} | confirmationEmailSentAt=${order.confirmationEmailSentAt}`,
);

if (order.paymentMethod !== "stripe") {
  console.error("Order is not a Stripe order — COD orders don't use webhooks");
  await mongoose.disconnect();
  process.exit(1);
}

// Reset confirmationEmailSentAt so we can test re-sending
await Order.updateOne(
  { _id: orderId },
  { $set: { confirmationEmailSentAt: null } },
);
console.log("Reset confirmationEmailSentAt → null");

await mongoose.disconnect();

// Build fake but correctly-signed webhook event
const stripe = new Stripe(STRIPE_SECRET);

// Use the existing sessionId from the order if available, or generate a fake one
const fakeSessionId = `cs_test_fake_${Date.now()}`;
const fakePaymentIntentId = `pi_test_${Date.now()}`;
const amountTotal = Number(order.pricing?.totalMinor ?? 0);

const payload = JSON.stringify({
  id: `evt_test_${Date.now()}`,
  object: "event",
  type: "checkout.session.completed",
  livemode: false,
  created: Math.floor(Date.now() / 1000),
  data: {
    object: {
      id: fakeSessionId,
      object: "checkout.session",
      payment_status: "paid",
      payment_intent: fakePaymentIntentId,
      amount_total: amountTotal,
      currency: "ils",
      metadata: { orderId },
    },
  },
});

// Sign the payload with the webhook secret (same algorithm Stripe uses)
const timestamp = Math.floor(Date.now() / 1000);
const signedPayload = `${timestamp}.${payload}`;
const { createHmac } = await import("node:crypto");
const sig = createHmac("sha256", WEBHOOK_SECRET)
  .update(signedPayload)
  .digest("hex");
const stripeSignature = `t=${timestamp},v1=${sig}`;

const options = {
  hostname: "127.0.0.1",
  port: PORT,
  path: "/api/v1/stripe/webhook",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "stripe-signature": stripeSignature,
  },
};

console.log(`\nSending webhook: checkout.session.completed`);
console.log(`  orderId  : ${orderId}`);
console.log(`  sessionId: ${fakeSessionId}`);
console.log(`  amount   : ${amountTotal} agorot`);

const req = http.request(options, (res) => {
  let body = "";
  res.on("data", (chunk) => (body += chunk));
  res.on("end", () => {
    console.log(`\nResponse status : ${res.statusCode}`);
    console.log(`Response body   : ${body}`);
    if (res.statusCode === 200) {
      console.log(
        "\n✅ Webhook processed successfully — check server logs for email trigger",
      );
    } else {
      console.log(
        "\n❌ Webhook returned non-200 — check server logs for details",
      );
    }
  });
});

req.on("error", (e) => console.error("Request error:", e.message));
req.write(payload);
req.end();
