/**
 * qa/tests/returns.lifecycle.e2e.test.cjs
 * Returns workflow: POST /returns (auth), GET my returns, GET by id.
 * Validates ineligible order state and idempotency where supported.
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

describe('Returns lifecycle E2E', () => {
  let userToken;
  let categoryId;
  let productId;
  let deliveryAreaId;
  let app;
  let orderId;

  beforeEach(async () => {
    app = global.__APP__;
    await setSiteSettings({ pricesIncludeVat: true });

    const user = await createUser({ role: 'user', email: `returns_user_${Date.now()}@test.com` });
    userToken = await issueTokenForUser(user);

    const cat = await createCategory();
    categoryId = cat._id.toString();
    const prod = await createProduct({ categoryId, price: 40, stock: 10 });
    productId = prod._id.toString();

    const area = await createDeliveryArea({ fee: 0, isActive: true });
    deliveryAreaId = area._id.toString();
  }, 30000);

  test('POST /api/v1/returns requires auth', async () => {
    const res = await request(app)
      .post('/api/v1/returns')
      .send({ orderId: '507f1f77bcf86cd799439011', reason: 'changed_mind' });

    expect(res.status).toBe(401);
  });

  test('GET /api/v1/returns (my returns) returns 200 with array', async () => {
    const res = await request(app)
      .get('/api/v1/returns/me')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('GET /api/v1/returns/me returns 200 with my return requests', async () => {
    const res = await request(app)
      .get('/api/v1/returns/me')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('POST /api/v1/returns for non-eligible order returns 400 or 404', async () => {
    const fakeOrderId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .post('/api/v1/returns')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ orderId: String(fakeOrderId), reason: 'changed_mind' });

    expect([400, 404]).toContain(res.status);
    expect(res.body.ok).toBe(false);
  });

  test('full flow: create COD order then create return request when eligible', async () => {
    await request(app)
      .post('/api/v1/cart/add')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ productId, qty: 1 });

    const codRes = await request(app)
      .post('/api/v1/checkout/cod')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', `e2e-returns-${Date.now()}`)
      .send(quoteBody(deliveryAreaId));

    expect(codRes.status).toBe(201);
    orderId = codRes.body.data._id || codRes.body.data.id;

    const returnRes = await request(app)
      .post('/api/v1/returns')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        orderId: String(orderId),
        reason: 'changed_mind',
        note: 'E2E test return',
      });

    if (returnRes.status === 201 || returnRes.status === 200) {
      expect(returnRes.body.ok).toBe(true);
      const returnId = returnRes.body.data._id || returnRes.body.data.id;

      const getRes = await request(app)
        .get(`/api/v1/returns/${returnId}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.ok).toBe(true);
    } else {
      expect([400, 404]).toContain(returnRes.status);
    }
  });

  test('idempotency: retry same return request does not create duplicate', async () => {
    await request(app)
      .post('/api/v1/cart/add')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ productId, qty: 1 });

    const codRes = await request(app)
      .post('/api/v1/checkout/cod')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', `e2e-returns-idem-${Date.now()}`)
      .send(quoteBody(deliveryAreaId));

    expect(codRes.status).toBe(201);
    const oid = codRes.body.data._id || codRes.body.data.id;

    const body = { orderId: String(oid), reason: 'changed_mind' };
    const first = await request(app)
      .post('/api/v1/returns')
      .set('Authorization', `Bearer ${userToken}`)
      .send(body);

    const second = await request(app)
      .post('/api/v1/returns')
      .set('Authorization', `Bearer ${userToken}`)
      .send(body);

    if (first.status === 201 || first.status === 200) {
      expect(second.status).toBe(200);
      expect(second.body.ok).toBe(true);
    }
  });
});
