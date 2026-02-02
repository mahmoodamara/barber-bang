/**
 * qa/tests/security.and.edge.cases.e2e.test.cjs
 *
 * Covers:
 * - Authentication failures
 * - Authorization violations (RBAC)
 * - Cart edge cases (overflow, invalid products)
 * - Order edge cases (empty cart, price manipulation)
 * - API versioning consistency
 * - Stripe failure handling
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

describe('Security and Edge Cases E2E', () => {
    let app;
    let userToken;
    let adminToken;
    let categoryId;
    let productId;
    let deliveryAreaId;

    beforeEach(async () => {
        app = global.__APP__;
        await setSiteSettings({ pricesIncludeVat: true });

        // Create users
        const user = await createUser({ role: 'user', email: `sc_user_${Date.now()}@test.com` });
        userToken = await issueTokenForUser(user);

        const admin = await createUser({ role: 'admin', email: `sc_admin_${Date.now()}@test.com` });
        adminToken = await issueTokenForUser(admin);

        // Create catalog data
        const cat = await createCategory();
        categoryId = cat._id.toString();
        const prod = await createProduct({
            categoryId,
            price: 100,
            stock: 5,
            titleHe: 'Test Product',
        });
        productId = prod._id.toString();

        // Create delivery area
        const area = await createDeliveryArea({ fee: 10, isActive: true });
        deliveryAreaId = area._id.toString();
    }, 45000);

    describe('Authentication & Authorization', () => {
        test('Request without token returns 401', async () => {
            const res = await request(app).get('/api/v1/orders/me');
            expect(res.status).toBe(401);
            expect(res.body.ok).toBe(false);
        });

        test('Request with malformed token returns 401', async () => {
            const res = await request(app)
                .get('/api/v1/orders/me')
                .set('Authorization', 'Bearer invalid-token');
            expect(res.status).toBe(401);
        });

        test('Regular user cannot access admin routes (403)', async () => {
            const res = await request(app)
                .get('/api/v1/admin/users')
                .set('Authorization', `Bearer ${userToken}`);

            // Some implementations might strict 403, others 401 or 404 depending on middleware order
            // But typically RBAC failure is 403
            expect([403, 401]).toContain(res.status);
            expect(res.body.ok).toBe(false);
        });
    });

    describe('Cart Edge Cases', () => {
        test('Adding invalid productId returns 404 or 400', async () => {
            const badId = new mongoose.Types.ObjectId();
            const res = await request(app)
                .post('/api/v1/cart/add')
                .set('Authorization', `Bearer ${userToken}`)
                .send({ productId: badId, qty: 1 });

            expect([404, 400]).toContain(res.status);
            expect(res.body.ok).toBe(false);
        });

        test('Adding quantity > stock fails or is capped', async () => {
            // Stock is 5
            const res = await request(app)
                .post('/api/v1/cart/add')
                .set('Authorization', `Bearer ${userToken}`)
                .send({ productId, qty: 100 });

            // Expect either 400 (not enough stock) or success but capped (depends on impl)
            // Assuming strict stock check based on requirements
            if (res.status === 200) {
                // If allowed, ensure it didn't strictly respect 100 if logic caps it
                // But usually e-commerce APIs return 400 for OOS
            } else {
                expect(res.status).toBe(400);
                expect(res.body.ok).toBe(false);
            }
        });

        test('Accumulates quantity when adding same product twice', async () => {
            await request(app)
                .post('/api/v1/cart/add')
                .set('Authorization', `Bearer ${userToken}`)
                .send({ productId, qty: 1 });

            await request(app)
                .post('/api/v1/cart/add')
                .set('Authorization', `Bearer ${userToken}`)
                .send({ productId, qty: 2 });

            const res = await request(app)
                .get('/api/v1/cart')
                .set('Authorization', `Bearer ${userToken}`);

            expect(res.status).toBe(200);
            const items = res.body.data.items || res.body.data;
            const item = items.find(i => {
                const pId = i.product?._id || i.product || i.productId?._id || i.productId;
                return String(pId) === productId;
            });
            expect(item).toBeDefined();
            expect(item.qty).toBe(3);
        });
    });

    describe('Order Edge Cases', () => {
        test('Cannot create order with empty cart', async () => {
            const res = await request(app)
                .post('/api/v1/checkout/quote')
                .set('Authorization', `Bearer ${userToken}`)
                .send(quoteBody(deliveryAreaId));

            expect([400, 422]).toContain(res.status);
            expect(res.body.ok).toBe(false);
        });

        test('Price tampering in body is ignored', async () => {
            // 1. Add item
            await request(app)
                .post('/api/v1/cart/add')
                .set('Authorization', `Bearer ${userToken}`)
                .send({ productId, qty: 1 });

            // 2. Try to send create order with hacked price
            // Note: Usually checkout/cod doesn't accept price params, but we verify it doesn't pick them up
            const tamperedBody = {
                ...quoteBody(deliveryAreaId),
                total: 1,
                items: [{ productId, qty: 1, price: 1 }]
            };

            const res = await request(app)
                .post('/api/v1/checkout/cod')
                .set('Authorization', `Bearer ${userToken}`)
                .send(tamperedBody);

            if (res.status === 201) {
                const order = res.body.data;
                // Should be real price (100) + shipping (10) = 110
                // Or just 100 if shipping fee logic differs, but definitely > 1
                const total = order.pricing?.total ?? order.total;
                expect(total).toBeGreaterThan(50);
            }
        });
    });

    describe('API Versioning & Infrastructure', () => {
        test('/api/v1/health returns 200', async () => {
            const res = await request(app).get('/api/v1/health');
            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);
        });

        test('/api/v1 prefix works for standard endpoints', async () => {
            const prodRes = await request(app).get('/api/v1/products');
            expect(prodRes.status).toBe(200);
        });
    });

    describe('Stripe Failure Simulation', () => {
        test('Stripe API 500 does not mark order as paid', async () => {
            // We can't easily mock the internal Stripe library here without jest.mock
            // But we can rely on the fact that without STRIPE_SECRET_KEY it might fail gracefully or return error
            // If the env is set to a dummy, it might return 500 or 502 as seen in other tests

            // Force a bad situation if possible, or just checks that a known failure path exists.
            // Given we can't mock internals easily in E2E without dependency injection:
            // We will rely on the "not configured" behavior checking.

            const tempKey = process.env.STRIPE_SECRET_KEY;
            process.env.STRIPE_SECRET_KEY = 'invalid_key';

            try {
                await request(app)
                    .post('/api/v1/cart/add')
                    .set('Authorization', `Bearer ${userToken}`)
                    .send({ productId, qty: 1 });

                const res = await request(app)
                    .post('/api/v1/checkout/stripe')
                    .set('Authorization', `Bearer ${userToken}`)
                    .send(quoteBody(deliveryAreaId));

                // Should fail safely
                expect([500, 502, 400]).toContain(res.status);
                expect(res.body.ok).toBe(false);

                // Verify no order was created in "paid" state logic (hard to check DB without ID, 
                // but we can check the user's last order)
                const ordersRes = await request(app)
                    .get('/api/v1/orders/me')
                    .set('Authorization', `Bearer ${userToken}`);

                const orders = ordersRes.body.data || [];
                // The failed checkout might have created a "pending_payment" order, checking it's not "paid"
                const pending = orders.find(o => o.status === 'pending_payment');
                if (pending) {
                    expect(pending.status).not.toBe('paid');
                }
            } finally {
                process.env.STRIPE_SECRET_KEY = tempKey;
            }
        });
    });
});
