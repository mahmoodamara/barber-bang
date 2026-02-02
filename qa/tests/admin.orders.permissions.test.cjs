/**
 * Verification: Refund permission decoupling (Option 2).
 * - User with only REFUNDS_WRITE can call refund endpoint (passes permission; staff gets REFUND_REQUIRES_APPROVAL).
 * - Same user gets 403 on list/get/status/shipping/cancel.
 * - User with only ORDERS_WRITE can call list/orders; gets 403 on refund.
 */
const request = require('supertest');
const { createUser, issueTokenForUser, createCategory, createProduct } = require('./helpers/factory.cjs');

async function importOrderModel() {
  try {
    return await import(process.cwd() + '/src/models/Order.js');
  } catch {
    return await import(process.cwd() + '/models/Order.js');
  }
}

async function createMinimalOrder({ userId, productId }) {
  const { Order } = await importOrderModel();
  return Order.create({
    userId,
    orderNumber: 'QA-PERM-' + Date.now(),
    currency: 'ils',
    items: [{
      productId,
      title: 'QA Item',
      unitPrice: 10,
      unitPriceMinor: 1000,
      qty: 1,
      lineTotal: 10,
      lineTotalMinor: 1000,
      variantId: '',
    }],
    gifts: [],
    status: 'confirmed',
    paymentMethod: 'cod',
    pricing: {
      subtotal: 10,
      shippingFee: 0,
      discounts: { coupon: { code: null, amount: 0 }, campaign: { amount: 0 }, offer: { amount: 0 } },
      total: 10,
      vatRate: 0.17,
      vatAmount: 0,
      totalBeforeVat: 10,
      totalAfterVat: 10,
      vatIncludedInPrices: true,
      subtotalMinor: 1000,
      shippingFeeMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 1000,
      vatAmountMinor: 0,
      totalBeforeVatMinor: 1000,
      totalAfterVatMinor: 1000,
      discountTotal: 0,
      couponCode: '',
      campaignId: null,
    },
    shipping: {
      mode: 'STORE_PICKUP',
      deliveryAreaId: null,
      pickupPointId: null,
      address: { fullName: '', phone: '', city: '', street: '', building: '', floor: '', apartment: '', entrance: '', notes: '' },
      snapshot: {},
      feeMinor: 0,
    },
  });
}

describe('Admin orders: REFUNDS_WRITE vs ORDERS_WRITE decoupling', () => {
  test('staff with only REFUNDS_WRITE gets 403 on list orders', async () => {
    const app = global.__APP__;
    const staff = await createUser({
      role: 'staff',
      permissions: ['REFUNDS_WRITE'],
      email: `staff_refund_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(staff);

    const res = await request(app)
      .get('/api/admin/orders')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe("INSUFFICIENT_PERMISSIONS");
  });

  test('staff with only REFUNDS_WRITE can reach refund endpoint (permission passes; staff gets REFUND_REQUIRES_APPROVAL)', async () => {
    const app = global.__APP__;
    const staff = await createUser({
      role: 'staff',
      permissions: ['REFUNDS_WRITE'],
      email: `staff_refund2_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(staff);
    const cat = await createCategory();
    const product = await createProduct({ categoryId: cat._id, price: 10, stock: 10 });
    const order = await createMinimalOrder({ userId: staff._id, productId: product._id });

    const res = await request(app)
      .post(`/api/admin/orders/${order._id}/refund`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `qa_perm_${order._id}`)
      .send({ amount: 10, reason: 'other', note: 'permission test' });

    // Permission passed (no INSUFFICIENT_PERMISSIONS). Staff gets 403 with REFUND_REQUIRES_APPROVAL.
    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('REFUND_REQUIRES_APPROVAL');
  });

  test('staff with only ORDERS_WRITE can list orders', async () => {
    const app = global.__APP__;
    const staff = await createUser({
      role: 'staff',
      permissions: ['ORDERS_WRITE'],
      email: `staff_orders_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(staff);

    const res = await request(app)
      .get('/api/admin/orders')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(Array.isArray(res.body?.data)).toBe(true);
  });

  test('staff with only ORDERS_WRITE gets 403 on refund', async () => {
    const app = global.__APP__;
    const staff = await createUser({
      role: 'staff',
      permissions: ['ORDERS_WRITE'],
      email: `staff_orders2_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(staff);
    const cat = await createCategory();
    const product = await createProduct({ categoryId: cat._id, price: 10, stock: 10 });
    const order = await createMinimalOrder({ userId: staff._id, productId: product._id });

    const res = await request(app)
      .post(`/api/admin/orders/${order._id}/refund`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `qa_perm2_${order._id}`)
      .send({ amount: 10, reason: 'other', note: 'permission test' });

    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
  });
});
