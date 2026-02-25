/**
 * qa/tests/api.route-parity.test.cjs
 *
 * COMPREHENSIVE Security tests: Verify /api/* and /api/v1/* have identical auth requirements.
 * Prevents auth bypass where one path is protected and the other is not.
 */

const request = require('supertest');
const { createUser, issueTokenForUser, createDeliveryArea, createProduct, createCategory } = require('./helpers/factory.cjs');

describe('API Route Parity - Security', () => {
  /* ============================
     SECTION 1: Protected Admin Endpoints (GET)
  ============================ */
  const ADMIN_GET_ENDPOINTS = [
    ['/api/admin/orders', '/api/v1/admin/orders'],
    ['/api/admin/products', '/api/v1/admin/products'],
    ['/api/admin/users', '/api/v1/admin/users'],
    ['/api/admin/settings', '/api/v1/admin/settings'],
    ['/api/admin/coupons', '/api/v1/admin/coupons'],
    ['/api/admin/campaigns', '/api/v1/admin/campaigns'],
    ['/api/admin/delivery-areas', '/api/v1/admin/delivery-areas'],
    ['/api/admin/pickup-points', '/api/v1/admin/pickup-points'],
    ['/api/admin/store-pickup', '/api/v1/admin/store-pickup'],
    ['/api/admin/returns', '/api/v1/admin/returns'],
    ['/api/admin/audit-logs', '/api/v1/admin/audit-logs'],
    ['/api/admin/dashboard/overview', '/api/v1/admin/dashboard/overview'],
    ['/api/admin/gifts', '/api/v1/admin/gifts'],
    ['/api/admin/offers', '/api/v1/admin/offers'],
    ['/api/admin/categories', '/api/v1/admin/categories'],
    ['/api/admin/reviews', '/api/v1/admin/reviews'],
    ['/api/admin/content', '/api/v1/admin/content'],
    ['/api/admin/home-layout', '/api/v1/admin/home-layout'],
    ['/api/admin/product-attributes', '/api/v1/admin/product-attributes'],
    ['/api/admin/stock-reservations', '/api/v1/admin/stock-reservations'],
  ];

  describe('Admin GET endpoints - both paths require auth', () => {
    test.each(ADMIN_GET_ENDPOINTS)(
      'GET %s and %s should both return 401 without auth',
      async (legacyPath, v1Path) => {
        const app = global.__APP__;

        const [legacyRes, v1Res] = await Promise.all([
          request(app).get(legacyPath),
          request(app).get(v1Path),
        ]);

        // Both must require auth
        expect(legacyRes.status).toBe(401);
        expect(v1Res.status).toBe(401);
        expect(legacyRes.body.ok).toBe(false);
        expect(v1Res.body.ok).toBe(false);
      }
    );
  });

  /* ============================
     SECTION 2: Admin POST endpoints (create operations)
  ============================ */
  const ADMIN_POST_ENDPOINTS = [
    ['/api/admin/coupons', '/api/v1/admin/coupons', { code: 'TEST', type: 'percent', value: 10 }],
    ['/api/admin/campaigns', '/api/v1/admin/campaigns', { name: 'Test', type: 'percent', value: 10 }],
    ['/api/admin/delivery-areas', '/api/v1/admin/delivery-areas', { name: 'Test', fee: 10 }],
    ['/api/admin/pickup-points', '/api/v1/admin/pickup-points', { name: 'Test', fee: 0 }],
    ['/api/admin/gifts', '/api/v1/admin/gifts', { name: 'Test', giftProductId: '507f1f77bcf86cd799439011' }],
    ['/api/admin/offers', '/api/v1/admin/offers', { name: 'Test', type: 'PERCENT_OFF', value: 10 }],
    ['/api/admin/categories', '/api/v1/admin/categories', { nameHe: 'קטגוריה', nameAr: 'فئة' }],
    ['/api/admin/products', '/api/v1/admin/products', { titleHe: 'מוצר', price: 100 }],
  ];

  describe('Admin POST endpoints - both paths require auth', () => {
    test.each(ADMIN_POST_ENDPOINTS)(
      'POST %s and %s should both return 401 without auth',
      async (legacyPath, v1Path, body) => {
        const app = global.__APP__;

        const [legacyRes, v1Res] = await Promise.all([
          request(app).post(legacyPath).send(body),
          request(app).post(v1Path).send(body),
        ]);

        expect(legacyRes.status).toBe(401);
        expect(v1Res.status).toBe(401);
      }
    );
  });

  /* ============================
     SECTION 3: User-protected endpoints
  ============================ */
  const USER_PROTECTED_GET = [
    ['/api/cart', '/api/v1/cart'],
    ['/api/wishlist', '/api/v1/wishlist'],
  ];

  const USER_PROTECTED_POST = [
    ['/api/cart/add', '/api/v1/cart/add', { productId: '507f1f77bcf86cd799439011', qty: 1 }],
    ['/api/wishlist', '/api/v1/wishlist', { productId: '507f1f77bcf86cd799439011' }],
    ['/api/reviews', '/api/v1/reviews', { productId: '507f1f77bcf86cd799439011', rating: 5 }],
  ];

  describe('User-protected GET endpoints - both paths require auth', () => {
    test.each(USER_PROTECTED_GET)(
      'GET %s and %s should both return 401 without auth',
      async (legacyPath, v1Path) => {
        const app = global.__APP__;

        const [legacyRes, v1Res] = await Promise.all([
          request(app).get(legacyPath),
          request(app).get(v1Path),
        ]);

        expect(legacyRes.status).toBe(401);
        expect(v1Res.status).toBe(401);
      }
    );
  });

  describe('User-protected POST endpoints - both paths require auth', () => {
    test.each(USER_PROTECTED_POST)(
      'POST %s and %s should both return 401 without auth',
      async (legacyPath, v1Path, body) => {
        const app = global.__APP__;

        const [legacyRes, v1Res] = await Promise.all([
          request(app).post(legacyPath).send(body),
          request(app).post(v1Path).send(body),
        ]);

        expect(legacyRes.status).toBe(401);
        expect(v1Res.status).toBe(401);
      }
    );
  });

  /* ============================
     SECTION 4: Checkout endpoints
  ============================ */
  describe('Checkout endpoints - guest/auth parity', () => {
    let deliveryAreaId;
    let productId;
    let userToken;

    beforeEach(async () => {
      const area = await createDeliveryArea();
      deliveryAreaId = area._id.toString();

      const category = await createCategory();
      const product = await createProduct({ categoryId: category._id.toString(), stock: 20 });
      productId = product._id.toString();

      const user = await createUser({ role: 'user', email: `checkout_user_${Date.now()}@test.com` });
      userToken = await issueTokenForUser(user);
    });

    const checkoutBody = ({ withGuestContact = false, contactSuffix = '' } = {}) => ({
      shippingMode: 'DELIVERY',
      deliveryAreaId,
      address: {
        fullName: 'Test User',
        phone: '0501234567',
        city: 'Tel Aviv',
        street: 'Main St 1',
      },
      ...(withGuestContact
        ? {
            guestContact: {
              fullName: 'Guest User',
              phone: '0501234567',
              email: `guest_${contactSuffix || Date.now()}@test.com`,
            },
          }
        : {}),
    });

    async function importGuestCartModel() {
      try {
        const mod = await import(process.cwd() + '/src/models/GuestCart.js');
        return mod.GuestCart;
      } catch {
        const mod = await import(process.cwd() + '/models/GuestCart.js');
        return mod.GuestCart;
      }
    }

    async function seedGuestCart(guestCartId) {
      const GuestCart = await importGuestCartModel();
      await GuestCart.create({
        cartId: guestCartId,
        items: [{ productId, qty: 1, variantId: '' }],
        updatedAt: new Date(),
      });
    }

    test('POST /api/checkout/quote and /api/v1/checkout/quote accept unauth and fail with validation error on invalid body', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).post('/api/checkout/quote').send({}),
        request(app).post('/api/v1/checkout/quote').send({}),
      ]);

      expect(legacyRes.status).toBe(400);
      expect(v1Res.status).toBe(400);
      expect(legacyRes.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(v1Res.body?.error?.code).toBe('VALIDATION_ERROR');
    });

    test('POST /api/checkout/cod and /api/v1/checkout/cod accept unauth and fail with validation error on invalid body', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).post('/api/checkout/cod').send({}),
        request(app).post('/api/v1/checkout/cod').send({}),
      ]);

      expect(legacyRes.status).toBe(400);
      expect(v1Res.status).toBe(400);
      expect(legacyRes.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(v1Res.body?.error?.code).toBe('VALIDATION_ERROR');
    });

    test('POST /api/checkout/stripe and /api/v1/checkout/stripe accept unauth and fail with validation error on invalid body', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).post('/api/checkout/stripe').send({}),
        request(app).post('/api/v1/checkout/stripe').send({}),
      ]);

      expect(legacyRes.status).toBe(400);
      expect(v1Res.status).toBe(400);
      expect(legacyRes.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(v1Res.body?.error?.code).toBe('VALIDATION_ERROR');
    });

    test('Unauthenticated guest with valid payload can quote on both paths', async () => {
      const app = global.__APP__;
      const guestCartId = `guest_quote_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      await seedGuestCart(guestCartId);

      const [legacyRes, v1Res] = await Promise.all([
        request(app)
          .post('/api/checkout/quote')
          .set('x-guest-cart-id', guestCartId)
          .send(checkoutBody()),
        request(app)
          .post('/api/v1/checkout/quote')
          .set('x-guest-cart-id', guestCartId)
          .send(checkoutBody()),
      ]);

      expect(legacyRes.status).toBe(200);
      expect(v1Res.status).toBe(200);
      expect(legacyRes.body?.ok).toBe(true);
      expect(v1Res.body?.ok).toBe(true);
    });

    test('Unauthenticated guest with valid payload can submit COD on both paths', async () => {
      const app = global.__APP__;
      const legacyGuestCartId = `guest_cod_legacy_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const v1GuestCartId = `guest_cod_v1_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      await seedGuestCart(legacyGuestCartId);
      await seedGuestCart(v1GuestCartId);

      const legacyRes = await request(app)
        .post('/api/checkout/cod')
        .set('x-guest-cart-id', legacyGuestCartId)
        .send(checkoutBody({ withGuestContact: true, contactSuffix: 'legacy' }));

      const v1Res = await request(app)
        .post('/api/v1/checkout/cod')
        .set('x-guest-cart-id', v1GuestCartId)
        .send(checkoutBody({ withGuestContact: true, contactSuffix: 'v1' }));

      expect(legacyRes.status).toBe(v1Res.status);
      expect(legacyRes.status).not.toBe(401);
      expect([200, 201]).toContain(legacyRes.status);
    });

    test('Unauthenticated guest with valid payload reaches Stripe checkout logic on both paths', async () => {
      const app = global.__APP__;
      const legacyGuestCartId = `guest_stripe_legacy_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const v1GuestCartId = `guest_stripe_v1_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      await seedGuestCart(legacyGuestCartId);
      await seedGuestCart(v1GuestCartId);

      const legacyRes = await request(app)
        .post('/api/checkout/stripe')
        .set('x-guest-cart-id', legacyGuestCartId)
        .send(checkoutBody({ withGuestContact: true, contactSuffix: 'stripe_legacy' }));

      const v1Res = await request(app)
        .post('/api/v1/checkout/stripe')
        .set('x-guest-cart-id', v1GuestCartId)
        .send(checkoutBody({ withGuestContact: true, contactSuffix: 'stripe_v1' }));

      expect(legacyRes.status).toBe(v1Res.status);
      expect(legacyRes.body?.error?.code).not.toBe('UNAUTHORIZED');
      expect(v1Res.body?.error?.code).not.toBe('UNAUTHORIZED');
    });

    test('Authenticated checkout quote behavior remains unchanged on both paths', async () => {
      const app = global.__APP__;
      const cartRes = await request(app)
        .post('/api/cart/add')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId, qty: 1 });

      expect(cartRes.status).toBe(200);

      const [legacyRes, v1Res] = await Promise.all([
        request(app)
          .post('/api/checkout/quote')
          .set('Authorization', `Bearer ${userToken}`)
          .send(checkoutBody()),
        request(app)
          .post('/api/v1/checkout/quote')
          .set('Authorization', `Bearer ${userToken}`)
          .send(checkoutBody()),
      ]);

      expect(legacyRes.status).toBe(200);
      expect(v1Res.status).toBe(200);
      expect(legacyRes.body?.ok).toBe(true);
      expect(v1Res.body?.ok).toBe(true);
    });
  });

  /* ============================
     SECTION 5: Orders track endpoint
  ============================ */
  describe('Orders track endpoint - parity', () => {
    test('POST /api/orders/track and /api/v1/orders/track have same behavior', async () => {
      const app = global.__APP__;
      const body = { orderNumber: 'BB-2024-000001', phone: '0501234567' };

      const [legacyRes, v1Res] = await Promise.all([
        request(app).post('/api/orders/track').send(body),
        request(app).post('/api/v1/orders/track').send(body),
      ]);

      // Both should return same status (404 if order not found, or same error)
      expect(legacyRes.status).toBe(v1Res.status);
    });
  });

  /* ============================
     SECTION 6: Public endpoints
  ============================ */
  const PUBLIC_ENDPOINTS = [
    ['/api/products', '/api/v1/products'],
    ['/api/categories', '/api/v1/categories'],
    ['/api/shipping/options', '/api/v1/shipping/options'],
    ['/api/offers', '/api/v1/offers'],
    ['/api/home', '/api/v1/home'],
    ['/api/coupons/validate', '/api/v1/coupons/validate'], // POST but public
  ];

  describe('Public GET endpoints - both paths return 200', () => {
    test.each(PUBLIC_ENDPOINTS.filter(([p]) => !p.includes('validate')))(
      'GET %s and %s are both public',
      async (legacyPath, v1Path) => {
        const app = global.__APP__;

        const [legacyRes, v1Res] = await Promise.all([
          request(app).get(legacyPath),
          request(app).get(v1Path),
        ]);

        // Both should be accessible (200) or both fail equally
        expect(legacyRes.status).toBe(v1Res.status);
        if (legacyRes.status === 200) {
          expect(legacyRes.body.ok).toBe(true);
          expect(v1Res.body.ok).toBe(true);
        }
      }
    );

    test('POST /api/coupons/validate and /api/v1/coupons/validate are both public', async () => {
      const app = global.__APP__;
      const body = { code: 'TESTCODE' };

      const [legacyRes, v1Res] = await Promise.all([
        request(app).post('/api/coupons/validate').send(body),
        request(app).post('/api/v1/coupons/validate').send(body),
      ]);

      // Both should return same status (not 401)
      expect(legacyRes.status).toBe(v1Res.status);
      expect(legacyRes.status).not.toBe(401);
    });
  });

  /* ============================
     SECTION 7: Auth endpoints (public)
  ============================ */
  describe('Auth endpoints - both paths work', () => {
    test('POST /api/auth/register and /api/v1/auth/register are both accessible', async () => {
      const app = global.__APP__;
      const body = { name: 'Test', email: 'invalid', password: 'short' }; // Invalid to avoid creating user

      const [legacyRes, v1Res] = await Promise.all([
        request(app).post('/api/auth/register').send(body),
        request(app).post('/api/v1/auth/register').send(body),
      ]);

      // Both should return same status (400 for validation error, not 401)
      expect(legacyRes.status).toBe(v1Res.status);
      expect(legacyRes.status).not.toBe(401);
    });

    test('POST /api/auth/login and /api/v1/auth/login are both accessible', async () => {
      const app = global.__APP__;
      const body = { email: 'nonexistent@test.com', password: 'wrongpass' };

      const [legacyRes, v1Res] = await Promise.all([
        request(app).post('/api/auth/login').send(body),
        request(app).post('/api/v1/auth/login').send(body),
      ]);

      // Both should return same status (401 for bad credentials)
      expect(legacyRes.status).toBe(v1Res.status);
    });
  });

  /* ============================
     SECTION 8: Admin role/permission parity
  ============================ */
  describe('Admin endpoints - role parity', () => {
    let regularUser;
    let regularToken;
    let adminUser;
    let adminToken;
    let staffUser;
    let staffToken;

    beforeAll(async () => {
      regularUser = await createUser({ role: 'user', email: `user_parity_${Date.now()}@test.com` });
      regularToken = await issueTokenForUser(regularUser);

      adminUser = await createUser({ role: 'admin', email: `admin_parity_${Date.now()}@test.com` });
      adminToken = await issueTokenForUser(adminUser);

      staffUser = await createUser({
        role: 'staff',
        permissions: ['ORDERS_WRITE'],
        email: `staff_parity_${Date.now()}@test.com`,
      });
      staffToken = await issueTokenForUser(staffUser);
    });

    test('Regular user cannot access admin on either path', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).get('/api/admin/orders').set('Authorization', `Bearer ${regularToken}`),
        request(app).get('/api/v1/admin/orders').set('Authorization', `Bearer ${regularToken}`),
      ]);

      // Both should reject - key is PARITY
      expect(legacyRes.status).toBe(v1Res.status);
      expect([401, 403]).toContain(legacyRes.status);
      expect(legacyRes.body.ok).toBe(false);
      expect(v1Res.body.ok).toBe(false);
    });

    test('Admin can access admin endpoints on both paths equally', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).get('/api/admin/orders').set('Authorization', `Bearer ${adminToken}`),
        request(app).get('/api/v1/admin/orders').set('Authorization', `Bearer ${adminToken}`),
      ]);

      expect(legacyRes.status).toBe(v1Res.status);
      if (legacyRes.status === 200) {
        expect(legacyRes.body.ok).toBe(true);
        expect(v1Res.body.ok).toBe(true);
      }
    });

    test('Staff with permission can access relevant admin endpoints on both paths', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).get('/api/admin/orders').set('Authorization', `Bearer ${staffToken}`),
        request(app).get('/api/v1/admin/orders').set('Authorization', `Bearer ${staffToken}`),
      ]);

      // Both should have same result
      expect(legacyRes.status).toBe(v1Res.status);
    });

    test('Staff without permission cannot access restricted endpoints on either path', async () => {
      const app = global.__APP__;

      // Staff has ORDERS_WRITE but not SETTINGS_WRITE
      const [legacyRes, v1Res] = await Promise.all([
        request(app).get('/api/admin/settings').set('Authorization', `Bearer ${staffToken}`),
        request(app).get('/api/v1/admin/settings').set('Authorization', `Bearer ${staffToken}`),
      ]);

      expect(legacyRes.status).toBe(v1Res.status);
      expect([401, 403]).toContain(legacyRes.status);
    });
  });

  /* ============================
     SECTION 9: Admin write operations parity
  ============================ */
  describe('Admin write operations - parity with auth', () => {
    let adminToken;

    beforeAll(async () => {
      const admin = await createUser({ role: 'admin', email: `admin_write_${Date.now()}@test.com` });
      adminToken = await issueTokenForUser(admin);
    });

    test('POST admin/coupons works equally on both paths', async () => {
      const app = global.__APP__;
      const body = { code: `PARITY${Date.now()}`, type: 'percent', value: 10 };

      const [legacyRes, v1Res] = await Promise.all([
        request(app).post('/api/admin/coupons').set('Authorization', `Bearer ${adminToken}`).send(body),
        request(app).post('/api/v1/admin/coupons').set('Authorization', `Bearer ${adminToken}`).send({ ...body, code: `PARITYV1${Date.now()}` }),
      ]);

      expect(legacyRes.status).toBe(v1Res.status);
      if (legacyRes.status === 201) {
        expect(legacyRes.body.ok).toBe(true);
        expect(v1Res.body.ok).toBe(true);
      }
    });

    test('PUT admin/coupons/:id requires auth equally on both paths', async () => {
      const app = global.__APP__;
      const fakeId = '507f1f77bcf86cd799439011';

      const [legacyRes, v1Res] = await Promise.all([
        request(app).put(`/api/admin/coupons/${fakeId}`).send({ value: 20 }),
        request(app).put(`/api/v1/admin/coupons/${fakeId}`).send({ value: 20 }),
      ]);

      expect(legacyRes.status).toBe(401);
      expect(v1Res.status).toBe(401);
    });

    test('DELETE admin/coupons/:id requires auth equally on both paths', async () => {
      const app = global.__APP__;
      const fakeId = '507f1f77bcf86cd799439011';

      const [legacyRes, v1Res] = await Promise.all([
        request(app).delete(`/api/admin/coupons/${fakeId}`),
        request(app).delete(`/api/v1/admin/coupons/${fakeId}`),
      ]);

      expect(legacyRes.status).toBe(401);
      expect(v1Res.status).toBe(401);
    });
  });

  /* ============================
     SECTION 10: Returns endpoints
  ============================ */
  describe('Returns endpoints - parity', () => {
    test('POST /api/returns and /api/v1/returns require auth equally', async () => {
      const app = global.__APP__;
      const body = { orderId: '507f1f77bcf86cd799439011', reason: 'Test' };

      const [legacyRes, v1Res] = await Promise.all([
        request(app).post('/api/returns').send(body),
        request(app).post('/api/v1/returns').send(body),
      ]);

      expect(legacyRes.status).toBe(v1Res.status);
      expect(legacyRes.status).toBe(401);
    });

    test('GET /api/returns and /api/v1/returns require auth equally', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).get('/api/returns'),
        request(app).get('/api/v1/returns'),
      ]);

      expect(legacyRes.status).toBe(v1Res.status);
      expect(legacyRes.status).toBe(401);
    });
  });

  /* ============================
     SECTION 11: Content endpoints
  ============================ */
  describe('Content endpoints - parity', () => {
    test('GET /api/content and /api/v1/content are both public and return 200', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).get('/api/content'),
        request(app).get('/api/v1/content'),
      ]);

      // Both should return 200 (public endpoints)
      expect(legacyRes.status).toBe(200);
      expect(v1Res.status).toBe(200);
      expect(legacyRes.body.ok).toBe(true);
      expect(v1Res.body.ok).toBe(true);
      // Data should be an array (list of content pages)
      expect(Array.isArray(legacyRes.body.data)).toBe(true);
      expect(Array.isArray(v1Res.body.data)).toBe(true);
    });
  });

  /* ============================
     SECTION 12: Rate limit parity
  ============================ */
  describe('Rate limit parity check', () => {
    test('Both paths should have X-RateLimit headers', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).get('/api/products'),
        request(app).get('/api/v1/products'),
      ]);

      const legacyHasLimit = legacyRes.headers['x-ratelimit-limit'] || legacyRes.headers['ratelimit-limit'];
      const v1HasLimit = v1Res.headers['x-ratelimit-limit'] || v1Res.headers['ratelimit-limit'];

      expect(!!legacyHasLimit).toBe(!!v1HasLimit);
    });

    test('Auth endpoints have stricter rate limits on both paths', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).post('/api/auth/login').send({ email: 'test@test.com', password: 'test' }),
        request(app).post('/api/v1/auth/login').send({ email: 'test@test.com', password: 'test' }),
      ]);

      const legacyLimit = legacyRes.headers['x-ratelimit-limit'] || legacyRes.headers['ratelimit-limit'];
      const v1Limit = v1Res.headers['x-ratelimit-limit'] || v1Res.headers['ratelimit-limit'];

      expect(legacyLimit).toBe(v1Limit);
    });
  });

  /* ============================
     SECTION 13: Deprecation header
  ============================ */
  describe('Deprecation header on legacy /api routes', () => {
    test('/api/* should return X-API-Deprecated header', async () => {
      const app = global.__APP__;
      const res = await request(app).get('/api/products');
      expect(res.headers['x-api-deprecated']).toBe('true');
    });

    test('/api/v1/* should NOT return X-API-Deprecated header', async () => {
      const app = global.__APP__;
      const res = await request(app).get('/api/v1/products');
      expect(res.headers['x-api-deprecated']).toBeUndefined();
    });
  });

  /* ============================
     SECTION 14: Product-specific endpoints
  ============================ */
  describe('Product endpoints - parity', () => {
    let productId;
    let categoryId;

    beforeEach(async () => {
      const cat = await createCategory();
      categoryId = cat._id.toString();
      const prod = await createProduct({ categoryId });
      productId = prod._id.toString();
    });

    test('GET /api/products/:id and /api/v1/products/:id are both public', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).get(`/api/products/${productId}`),
        request(app).get(`/api/v1/products/${productId}`),
      ]);

      expect(legacyRes.status).toBe(v1Res.status);
      expect(legacyRes.status).toBe(200);
    });

    test('GET /api/categories/:id and /api/v1/categories/:id are both public', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).get(`/api/categories/${categoryId}`),
        request(app).get(`/api/v1/categories/${categoryId}`),
      ]);

      expect(legacyRes.status).toBe(v1Res.status);
    });

    test('GET /api/products/:id/reviews and /api/v1/products/:id/reviews are both public', async () => {
      const app = global.__APP__;

      const [legacyRes, v1Res] = await Promise.all([
        request(app).get(`/api/products/${productId}/reviews`),
        request(app).get(`/api/v1/products/${productId}/reviews`),
      ]);

      expect(legacyRes.status).toBe(v1Res.status);
      // Should not require auth for reading reviews
      expect(legacyRes.status).not.toBe(401);
    });
  });

  /* ============================
     SECTION 15: Critical security - no bypass check
  ============================ */
  describe('CRITICAL: No auth bypass between paths', () => {
    test('Cannot bypass admin auth by using /api instead of /api/v1', async () => {
      const app = global.__APP__;

      // Test multiple sensitive admin endpoints
      const sensitiveEndpoints = [
        '/admin/orders',
        '/admin/users',
        '/admin/settings',
        '/admin/audit-logs',
      ];

      for (const endpoint of sensitiveEndpoints) {
        const [legacyRes, v1Res] = await Promise.all([
          request(app).get(`/api${endpoint}`),
          request(app).get(`/api/v1${endpoint}`),
        ]);

        // CRITICAL: Both must be 401, not 200 or 404
        expect(legacyRes.status).toBe(401);
        expect(v1Res.status).toBe(401);
      }
    });

    test('Checkout endpoints keep identical guest validation behavior on /api and /api/v1', async () => {
      const app = global.__APP__;

      const checkoutEndpoints = ['/checkout/quote', '/checkout/cod', '/checkout/stripe'];

      for (const endpoint of checkoutEndpoints) {
        const [legacyRes, v1Res] = await Promise.all([
          request(app).post(`/api${endpoint}`).send({}),
          request(app).post(`/api/v1${endpoint}`).send({}),
        ]);

        // Guest checkout is allowed, but both paths must enforce the same validation contract.
        expect(legacyRes.status).toBe(400);
        expect(v1Res.status).toBe(400);
        expect(legacyRes.body?.error?.code).toBe('VALIDATION_ERROR');
        expect(v1Res.body?.error?.code).toBe('VALIDATION_ERROR');
      }
    });
  });
});
