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

async function setUserCart(userId, items) {
  let User;
  try {
    ({ User } = await import(process.cwd() + '/src/models/User.js'));
  } catch {
    ({ User } = await import(process.cwd() + '/models/User.js'));
  }
  await User.updateOne({ _id: userId }, { $set: { cart: items } });
}

describe('Checkout quote: VAT invariants + server-side pricing integrity', () => {
  test('VAT invariant holds when pricesIncludeVat=true', async () => {
    const app = global.__APP__;
    await setSiteSettings({ pricesIncludeVat: true });

    const user = await createUser({ role: 'user' });
    const token = await issueTokenForUser(user);

    const cat = await createCategory();
    const p = await createProduct({ categoryId: cat._id, price: 100, stock: 10 });
    const area = await createDeliveryArea({ priceMinor: 0 });

    await setUserCart(user._id, [{ productId: p._id, qty: 2, variantId: '' }]);

    const res = await request(app)
      .post('/api/checkout/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        shippingMode: 'DELIVERY',
        deliveryAreaId: String(area._id),
        address: { fullName: 'QA', phone: '0500000000', city: 'TA', street: 'Main St' },
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    const q = res.body.data;

    expect(q.vatIncludedInPrices).toBe(true);
    expect(Number.isFinite(q.totalBeforeVatMinor)).toBe(true);
    expect(Number.isFinite(q.vatAmountMinor)).toBe(true);
    expect(Number.isFinite(q.totalAfterVatMinor)).toBe(true);

    expect(q.totalBeforeVatMinor + q.vatAmountMinor).toBe(q.totalAfterVatMinor);
  });

  test('VAT invariant holds when pricesIncludeVat=false', async () => {
    const app = global.__APP__;
    await setSiteSettings({ pricesIncludeVat: false });

    const user = await createUser({ role: 'user' });
    const token = await issueTokenForUser(user);

    const cat = await createCategory();
    const p = await createProduct({ categoryId: cat._id, price: 100, stock: 10 });
    const area = await createDeliveryArea({ priceMinor: 0 });

    await setUserCart(user._id, [{ productId: p._id, qty: 1, variantId: '' }]);

    const res = await request(app)
      .post('/api/checkout/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        shippingMode: 'DELIVERY',
        deliveryAreaId: String(area._id),
        address: { fullName: 'QA', phone: '0500000000', city: 'TA', street: 'Main St' },
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    const q = res.body.data;

    expect(q.vatIncludedInPrices).toBe(false);
    expect(q.totalBeforeVatMinor + q.vatAmountMinor).toBe(q.totalAfterVatMinor);
  });
});
