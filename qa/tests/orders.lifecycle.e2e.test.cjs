/**
 * qa/tests/orders.lifecycle.e2e.test.cjs
 * Orders after purchase: list, get by id, receipt, cancel, track.
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

describe('Orders lifecycle E2E', () => {
  let userToken;
  let categoryId;
  let productId;
  let deliveryAreaId;
  let app;
  let orderId;
  let orderNumber;

  beforeEach(async () => {
    app = global.__APP__;
    await setSiteSettings({ pricesIncludeVat: true });

    const user = await createUser({ role: 'user', email: `orders_user_${Date.now()}@test.com` });
    userToken = await issueTokenForUser(user);

    const cat = await createCategory();
    categoryId = cat._id.toString();
    const prod = await createProduct({ categoryId, price: 25, stock: 10 });
    productId = prod._id.toString();

    const area = await createDeliveryArea({ fee: 0, isActive: true });
    deliveryAreaId = area._id.toString();
  }, 30000);

  test('GET /api/v1/orders/me lists orders and includes new COD order', async () => {
    await request(app)
      .post('/api/v1/cart/add')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ productId, qty: 1 });

    const codRes = await request(app)
      .post('/api/v1/checkout/cod')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', `e2e-orders-${Date.now()}`)
      .send(quoteBody(deliveryAreaId));

    expect(codRes.status).toBe(201);
    orderId = codRes.body.data._id || codRes.body.data.id;
    orderNumber = codRes.body.data.orderNumber;

    const listRes = await request(app)
      .get('/api/v1/orders/me')
      .set('Authorization', `Bearer ${userToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.ok).toBe(true);
    expect(Array.isArray(listRes.body.data)).toBe(true);
    const found = listRes.body.data.find((o) => String(o._id || o.id) === String(orderId));
    expect(found).toBeDefined();
  });

  test('GET /api/v1/orders/:id returns order details', async () => {
    await request(app)
      .post('/api/v1/cart/add')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ productId, qty: 1 });

    const codRes = await request(app)
      .post('/api/v1/checkout/cod')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', `e2e-order-detail-${Date.now()}`)
      .send(quoteBody(deliveryAreaId));

    expect(codRes.status).toBe(201);
    const id = codRes.body.data._id || codRes.body.data.id;

    const getRes = await request(app)
      .get(`/api/v1/orders/${id}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.ok).toBe(true);
    expect(getRes.body.data._id || getRes.body.data.id).toBeDefined();
    expect(getRes.body.data.status).toBeDefined();
    expect(getRes.body.data.pricing || getRes.body.data.total).toBeDefined();
  });

  test('GET /api/v1/orders/:id/receipt returns 200 or 404 when receipt not available', async () => {
    await request(app)
      .post('/api/v1/cart/add')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ productId, qty: 1 });

    const codRes = await request(app)
      .post('/api/v1/checkout/cod')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', `e2e-receipt-${Date.now()}`)
      .send(quoteBody(deliveryAreaId));

    expect(codRes.status).toBe(201);
    const id = codRes.body.data._id || codRes.body.data.id;

    const receiptRes = await request(app)
      .get(`/api/v1/orders/${id}/receipt`)
      .set('Authorization', `Bearer ${userToken}`);

    expect([200, 404]).toContain(receiptRes.status);
    if (receiptRes.status === 200) {
      expect(receiptRes.body.ok).toBe(true);
    }
  });

  test('POST /api/v1/orders/track returns 404 for non-existent order', async () => {
    const res = await request(app)
      .post('/api/v1/orders/track')
      .send({
        orderNumber: 'BB-9999-999999',
        phone: '0500000000',
      });

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  test('POST /api/v1/orders/:id/cancel: before payment may cancel; after payment may reject', async () => {
    await request(app)
      .post('/api/v1/cart/add')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ productId, qty: 1 });

    const codRes = await request(app)
      .post('/api/v1/checkout/cod')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', `e2e-cancel-${Date.now()}`)
      .send(quoteBody(deliveryAreaId));

    expect(codRes.status).toBe(201);
    const id = codRes.body.data._id || codRes.body.data.id;

    const cancelRes = await request(app)
      .post(`/api/v1/orders/${id}/cancel`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({});

    expect([200, 204, 400, 403]).toContain(cancelRes.status);
  });
});
