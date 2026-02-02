const request = require('supertest');
const mongoose = require('mongoose');
const { createUser, issueTokenForUser, createCategory, createProduct, createDeliveryArea, setSiteSettings } = require('./helpers/factory.cjs');

async function importOrderModel() {
  try { return await import(process.cwd() + '/src/models/Order.js'); }
  catch { return await import(process.cwd() + '/models/Order.js'); }
}

async function createMinimalOrder({ userId, productId }) {
  const { Order } = await importOrderModel();

  return Order.create({
    userId,
    orderNumber: 'QA-1',
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
    status: 'delivered',
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

describe('Admin governance: refund approvals workflow', () => {
  test('staff requests refund -> admin approves -> order becomes refunded', async () => {
    const app = global.__APP__;
    await setSiteSettings({ pricesIncludeVat: true });

    const admin = await createUser({ role: 'admin', email: `admin_${Date.now()}@example.com` });
    const adminToken = await issueTokenForUser(admin);

    // Staff must be able to hold REFUNDS_WRITE. If your User schema blocks it, this test will fail.
    const staff = await createUser({
      role: 'staff',
      permissions: ['REFUNDS_WRITE'],
      email: `staff_${Date.now()}@example.com`,
    });
    const staffToken = await issueTokenForUser(staff);

    const cat = await createCategory();
    const product = await createProduct({ categoryId: cat._id, price: 10, stock: 10 });

    const order = await createMinimalOrder({ userId: staff._id, productId: product._id });

    // 1) staff creates approval request
    const createApproval = await request(app)
      .post('/api/admin/approvals')
      .set('Authorization', `Bearer ${staffToken}`)
      .set('Idempotency-Key', `qa_refund_${order._id}`)
      .send({
        actionType: 'REFUND',
        payload: { orderId: String(order._id), amount: 10, reason: 'qa', note: 'qa refund' },
      })
      .expect(201);

    expect(createApproval.body.ok).toBe(true);
    const approvalId = createApproval.body.data?._id || createApproval.body.data?.id;
    expect(approvalId).toBeTruthy();

    // 2) admin approves
    const approve = await request(app)
      .patch(`/api/admin/approvals/${approvalId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'approved' })
      .expect(200);

    expect(approve.body.ok).toBe(true);

    // 3) verify order status
    const { Order } = await importOrderModel();
    const fresh = await Order.findById(order._id).lean();
    expect(fresh.status).toBe('refunded');
    expect(fresh.refund?.status).toBe('succeeded');
  });
});
