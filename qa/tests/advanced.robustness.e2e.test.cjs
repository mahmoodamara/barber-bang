/**
 * qa/tests/advanced.robustness.e2e.test.cjs
 *
 * Advanced scenarios:
 * - Concurrency (Stock race)
 * - Security (Token reuse, permissions, poisoning)
 * - Idempotency
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
        address: { fullName: 'Adv User', phone: '0501234567', city: 'Tel Aviv', street: 'Robust St 1' },
    };
}

describe('Advanced Robustness & Security E2E', () => {
    let app;
    let adminToken;
    let categoryId;
    let deliveryAreaId;

    beforeEach(async () => {
        app = global.__APP__;
        await setSiteSettings({ pricesIncludeVat: true });

        const admin = await createUser({ role: 'admin', email: `adv_admin_${Date.now()}@test.com` });
        adminToken = await issueTokenForUser(admin);

        const cat = await createCategory();
        categoryId = cat._id.toString();

        const area = await createDeliveryArea({ fee: 10, isActive: true });
        deliveryAreaId = area._id.toString();
    }, 45000);

    describe('Concurrency & Race Conditions', () => {
        test('Stock Race: 2 users competing for last 1 item -> only 1 success', async () => {
            // 1. Setup: Product with Stock = 1
            const prod = await createProduct({ categoryId, price: 100, stock: 1, titleHe: 'RaceItem' });
            const productId = prod._id.toString();

            // 2. Setup: Two users with tokens
            const user1 = await createUser({ email: `race1_${Date.now()}@test.com` });
            const token1 = await issueTokenForUser(user1);

            const user2 = await createUser({ email: `race2_${Date.now()}@test.com` });
            const token2 = await issueTokenForUser(user2);

            // 3. Both add to cart
            await request(app).post('/api/v1/cart/add').set('Authorization', `Bearer ${token1}`).send({ productId, qty: 1 });
            await request(app).post('/api/v1/cart/add').set('Authorization', `Bearer ${token2}`).send({ productId, qty: 1 });

            // 4. Fire simultaneous checkout requests
            const p1 = request(app)
                .post('/api/v1/checkout/cod')
                .set('Authorization', `Bearer ${token1}`)
                .send(quoteBody(deliveryAreaId));

            const p2 = request(app)
                .post('/api/v1/checkout/cod')
                .set('Authorization', `Bearer ${token2}`)
                .send(quoteBody(deliveryAreaId));

            const [res1, res2] = await Promise.all([p1, p2]);

            // 5. Assertions: Exactly one 201, one 400/409/422
            const successes = [res1, res2].filter(r => r.status === 201);
            const failures = [res1, res2].filter(r => r.status >= 400);

            expect(successes.length).toBe(1);
            expect(failures.length).toBe(1);
            expect(failures[0].body.ok).toBe(false);

            // Verify stock in DB is 0 (or reserved)
            const Product = (await import(process.cwd() + '/src/models/Product.js')).Product;
            const updatedProd = await Product.findById(productId);
            expect(updatedProd.stock).toBe(0);
        });
    });

    describe('Security Exploits', () => {
        test('Token Reuse: Logout invalidates token immediately', async () => {
            const user = await createUser();
            const token = await issueTokenForUser(user);

            // Verify access works
            const res1 = await request(app).get('/api/v1/orders/me').set('Authorization', `Bearer ${token}`);
            expect(res1.status).toBe(200);

            // Logout
            const logoutRes = await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`);
            expect(logoutRes.status).toBe(200);

            // Verify access denied
            const res2 = await request(app).get('/api/v1/orders/me').set('Authorization', `Bearer ${token}`);
            expect([401, 403]).toContain(res2.status);
        });

        test('Cart Poisoning: Price change in DB invalidates cached cart price', async () => {
            // 1. Create product @ 100
            const prod = await createProduct({ categoryId, price: 100, stock: 10 });
            const productId = prod._id.toString();

            const user = await createUser();
            const token = await issueTokenForUser(user);

            // 2. Add to cart (cart now has item @ 100)
            await request(app).post('/api/v1/cart/add').set('Authorization', `Bearer ${token}`).send({ productId, qty: 1 });

            // 3. Admin changes price to 200 in DB
            const Product = (await import(process.cwd() + '/src/models/Product.js')).Product;
            await Product.updateOne({ _id: productId }, { $set: { price: 200, priceMinor: 20000 } });

            // 4. User attempts checkout
            // The system SHOULD recalculate price from DB, not trust cart/client
            const res = await request(app)
                .post('/api/v1/checkout/cod')
                .set('Authorization', `Bearer ${token}`)
                .send(quoteBody(deliveryAreaId));

            expect(res.status).toBe(201);
            const order = res.body.data;

            // Verification: Total should reflect NEW price (200) + shipping (10) = 210
            // If it kept old price (110), security test failed.
            const total = order.pricing?.total ?? order.total;
            expect(total).toBeCloseTo(210);
        });
    });

    describe('Idempotency & Replay', () => {
        test('COD Checkout: Retrying with same Idempotency-Key returns SAME order', async () => {
            const user = await createUser();
            const token = await issueTokenForUser(user);
            const prod = await createProduct({ categoryId, price: 50, stock: 10 });

            await request(app).post('/api/v1/cart/add').set('Authorization', `Bearer ${token}`).send({ productId: prod._id, qty: 1 });

            const key = `idem_${Date.now()}`;

            // First Attempt
            const res1 = await request(app)
                .post('/api/v1/checkout/cod')
                .set('Authorization', `Bearer ${token}`)
                .set('Idempotency-Key', key)
                .send(quoteBody(deliveryAreaId));

            expect(res1.status).toBe(201);
            const order1Id = res1.body.data._id || res1.body.data.id;

            // Second Attempt (Replay)
            // Even if body is slightly different, idempotency key usually triggers cached response
            const res2 = await request(app)
                .post('/api/v1/checkout/cod')
                .set('Authorization', `Bearer ${token}`)
                .set('Idempotency-Key', key)
                .send(quoteBody(deliveryAreaId));

            expect(res2.status).toBe(200); // Usually 200 OK for replay, or 201
            const order2Id = res2.body.data._id || res2.body.data.id;

            expect(order1Id).toBe(order2Id);
        });
    });

    describe('Admin Boundaries & RBAC', () => {
        test('Recursive ID guessing does not allow user to delete products', async () => {
            // Create product
            const prod = await createProduct({ categoryId, price: 10, stock: 10 });
            const targetId = prod._id.toString();

            // Standard user
            const user = await createUser();
            const token = await issueTokenForUser(user);

            // Attempt delete
            const res = await request(app)
                .delete(`/api/v1/admin/products/${targetId}`)
                .set('Authorization', `Bearer ${token}`);

            // Expect Forbidden
            expect([403, 401, 404]).toContain(res.status);

            // Verify product still exists
            const Product = (await import(process.cwd() + '/src/models/Product.js')).Product;
            const check = await Product.findById(targetId);
            expect(check).not.toBeNull();
        });
    });
});
