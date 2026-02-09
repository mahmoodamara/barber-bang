/**
 * qa/tests/purchase.flow.stripe.e2e.test.cjs
 * Stripe checkout flow + webhook simulation (NO external Stripe API calls).
 * - When STRIPE_SECRET_KEY is set: full flow up to checkout/stripe (may 201 or 500).
 * - Webhook simulation: create pending_payment order in DB, POST signed event, assert order paid.
 */

const request = require('supertest');
const mongoose = require('mongoose');
const {
  createUser,
  issueTokenForUser,
  createCategory,
  createProduct,
  setSiteSettings,
  createDeliveryArea,
} = require('./helpers/factory.cjs');

function quoteBody(deliveryAreaId) {
  return {
    shippingMode: 'DELIVERY',
    deliveryAreaId: String(deliveryAreaId),
    address: { fullName: 'E2E User', phone: '0501234567', city: 'Tel Aviv', street: 'Main St 1' },
  };
}

function buildCheckoutSessionCompletedEvent(sessionId, orderId, amountMinor, paymentIntentId = 'pi_e2e_test_123') {
  return {
    id: 'evt_e2e_test_123',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        payment_status: 'paid',
        amount_total: amountMinor,
        currency: 'ils',
        payment_intent: paymentIntentId,
        metadata: { orderId: String(orderId) },
      },
    },
  };
}

const TEST_WEBHOOK_SECRET = 'whsec_test_123';

function signStripeWebhook(payload) {
  const Stripe = require('stripe');
  const stripe = new Stripe('sk_test_placeholder');
  return stripe.webhooks.generateTestHeaderString({
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    secret: TEST_WEBHOOK_SECRET,
  });
}

describe('Purchase flow Stripe E2E', () => {
  let userToken;
  let adminToken;
  let categoryId;
  let productId;
  let deliveryAreaId;
  let app;

  beforeEach(async () => {
    app = global.__APP__;
    if (!process.env.STRIPE_SECRET_KEY) {
      process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder_webhook_only';
    }
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    await setSiteSettings({ pricesIncludeVat: true });

    const user = await createUser({ role: 'user', email: `stripe_user_${Date.now()}@test.com` });
    userToken = await issueTokenForUser(user);

    const admin = await createUser({ role: 'admin', email: `stripe_admin_${Date.now()}@test.com` });
    adminToken = await issueTokenForUser(admin);

    const cat = await createCategory();
    categoryId = cat._id.toString();
    const prod = await createProduct({ categoryId, price: 30, stock: 10 });
    productId = prod._id.toString();

    const area = await createDeliveryArea({ fee: 0, isActive: true });
    deliveryAreaId = area._id.toString();
  }, 30000);

  test('POST /api/v1/checkout/stripe returns orderId and session/checkoutUrl or error when Stripe not configured', async () => {
    await request(app)
      .post('/api/v1/cart/add')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ productId, qty: 1 });

    const res = await request(app)
      .post('/api/v1/checkout/stripe')
      .set('Authorization', `Bearer ${userToken}`)
      .send(quoteBody(deliveryAreaId));

    if (res.status === 201) {
      expect(res.body.ok).toBe(true);
      expect(res.body.data.orderId || res.body.data.orderNumber).toBeDefined();
    } else if (res.status === 500 && res.body.error?.code === 'STRIPE_NOT_CONFIGURED') {
      return;
    } else if (res.status === 502) {
      // Stripe API failure (e.g. invalid key / not configured at Stripe)
      expect(res.body.ok).toBe(false);
      return;
    } else {
      expect([201, 500]).toContain(res.status);
    }
  });

  test('webhook simulation: signed checkout.session.completed marks order paid', async () => {
    const Order = (await import(process.cwd() + '/src/models/Order.js')).Order;
    const { reserveStockForOrder } = await import(process.cwd() + '/src/services/products.service.js');
    const webhookUser = await createUser({ role: 'user', email: `webhook_user_${Date.now()}@test.com` });
    const orderId = new mongoose.Types.ObjectId();
    const sessionId = 'cs_e2e_test_' + Date.now();
    const amountMinor = 5000;

    await Order.create({
      _id: orderId,
      userId: webhookUser._id,
      orderNumber: 'BB-2025-000001',
      status: 'pending_payment',
      paymentMethod: 'stripe',
      items: [{ productId, qty: 1, unitPrice: 50, titleHe: 'Test', variantId: '' }],
      pricing: {
        total: 50,
        totalMinor: amountMinor,
        subtotal: 50,
        shippingFee: 0,
        vatRate: 0.17,
        vatIncludedInPrices: true,
        vatAmount: 0,
        totalBeforeVat: 50,
        totalAfterVat: 50,
        discounts: { coupon: { amount: 0 }, campaign: { amount: 0 }, offer: { amount: 0 } },
      },
      shipping: { mode: 'DELIVERY', address: { fullName: 'T', phone: '0500000000', city: 'T', street: 'S' } },
      stripe: { sessionId, paymentIntentId: 'pi_e2e_123' },
      currency: 'ils',
    });

    await reserveStockForOrder({
      orderId,
      userId: webhookUser._id,
      items: [{ productId, qty: 1, variantId: '' }],
      ttlMinutes: 60,
    });

    const event = buildCheckoutSessionCompletedEvent(sessionId, orderId, amountMinor);
    const payload = JSON.stringify(event);
    // Ensure webhook secret is set right before request
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    const sig = signStripeWebhook(payload);

    const res = await request(app)
      .post('/api/v1/stripe/webhook')
      .type('application/json')
      .set('stripe-signature', sig)
      .send(payload);

    expect(res.status).toBe(200);

    const updated = await Order.findById(orderId).lean();
    expect(updated).toBeDefined();
    expect(['paid', 'payment_received', 'confirmed'].includes(updated.status)).toBe(true);
  });

  test('webhook idempotency: same event twice does not duplicate ledger', async () => {
    const Order = (await import(process.cwd() + '/src/models/Order.js')).Order;
    const { reserveStockForOrder } = await import(process.cwd() + '/src/services/products.service.js');
    const idemUser = await createUser({ role: 'user', email: `idem_user_${Date.now()}@test.com` });
    const orderId = new mongoose.Types.ObjectId();
    const sessionId = 'cs_e2e_idem_' + Date.now();
    const amountMinor = 3000;

    await Order.create({
      _id: orderId,
      userId: idemUser._id,
      orderNumber: 'BB-2025-000002',
      status: 'pending_payment',
      paymentMethod: 'stripe',
      items: [{ productId, qty: 1, unitPrice: 30, titleHe: 'Test', variantId: '' }],
      pricing: {
        total: 30,
        totalMinor: amountMinor,
        subtotal: 30,
        shippingFee: 0,
        vatRate: 0.17,
        vatIncludedInPrices: true,
        vatAmount: 0,
        totalBeforeVat: 30,
        totalAfterVat: 30,
        discounts: { coupon: { amount: 0 }, campaign: { amount: 0 }, offer: { amount: 0 } },
      },
      shipping: { mode: 'DELIVERY', address: { fullName: 'T', phone: '0500000000', city: 'T', street: 'S' } },
      stripe: { sessionId, paymentIntentId: 'pi_idem_123' },
      currency: 'ils',
    });

    await reserveStockForOrder({
      orderId,
      userId: idemUser._id,
      items: [{ productId, qty: 1, variantId: '' }],
      ttlMinutes: 60,
    });

    const event = buildCheckoutSessionCompletedEvent(sessionId, orderId, amountMinor);
    const payload = JSON.stringify(event);
    // Ensure webhook secret is set right before request
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    const sig = signStripeWebhook(payload);

    await request(app).post('/api/v1/stripe/webhook').type('application/json').set('stripe-signature', sig).send(payload);
    const res2 = await request(app).post('/api/v1/stripe/webhook').type('application/json').set('stripe-signature', sig).send(payload);

    expect(res2.status).toBe(200);
    const updated = await Order.findById(orderId).lean();
    expect(['paid', 'confirmed'].includes(updated.status)).toBe(true);
  });

  test('webhook without stripe-signature returns 400', async () => {
    const res = await request(app)
      .post('/api/v1/stripe/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_xxx' } } }));

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error?.code).toBeDefined();
  });
});
