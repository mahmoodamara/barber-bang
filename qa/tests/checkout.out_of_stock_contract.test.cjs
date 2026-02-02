const request = require('supertest');
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

describe('Checkout: out-of-stock API contract (no silent qty reduction)', () => {
  test('quote returns 409 OUT_OF_STOCK_PARTIAL with details', async () => {
    const app = global.__APP__;
    await setSiteSettings({ pricesIncludeVat: true });

    const user = await createUser();
    const token = await issueTokenForUser(user);

    const cat = await createCategory();
    const p = await createProduct({ categoryId: cat._id, price: 50, stock: 1 });
    const area = await createDeliveryArea({ priceMinor: 0 });

    // Request 2 but only 1 in stock
    await setUserCart(user._id, [{ productId: p._id, qty: 2, variantId: '' }]);

    const res = await request(app)
      .post('/api/checkout/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        shippingMode: 'DELIVERY',
        deliveryAreaId: String(area._id),
        address: { fullName: 'QA', phone: '0500000000', city: 'TA', street: 'Main St' },
      });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('OUT_OF_STOCK_PARTIAL');

    // Frontend-safe contract: details must exist
    expect(res.body.error.details).toBeTruthy();
    expect(Array.isArray(res.body.error.details.items || res.body.error.details)).toBe(true);
  });
});
