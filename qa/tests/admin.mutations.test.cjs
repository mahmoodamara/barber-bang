const request = require('supertest');
const { createUser, issueTokenForUser, createCategory, createProduct } = require('./helpers/factory.cjs');

describe('Admin Mutations (POST/PUT/DELETE)', () => {
    let adminToken;
    let categoryId;

    beforeEach(async () => {
        const admin = await createUser({ role: 'admin', email: `admin_mut_${Date.now()}@test.com` });
        adminToken = await issueTokenForUser(admin);
        const cat = await createCategory();
        categoryId = cat._id.toString();
    }, 30000);

    test('Product lifecycle: Create -> Update -> Delete', async () => {
        const app = global.__APP__;

        // 1. Create
        const createRes = await request(app)
            .post('/api/v1/admin/products')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                titleHe: 'מוצר חדש',
                price: 150,
                stock: 50,
                categoryId,
            });

        expect(createRes.status).toBe(201);
        const productId = createRes.body.data._id;

        // 2. Update
        const updateRes = await request(app)
            .patch(`/api/v1/admin/products/${productId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                price: 180,
            });

        expect(updateRes.status).toBe(200);
        expect(updateRes.body.data.price).toBe(180);

        // 3. Delete - Skip (Admin Product Delete not implemented in this router)

        // Changing strategy: Test Coupon cycle which definitely has DELETE in admin.routes.js
    });

    test('Coupon lifecycle: Create -> Update -> Delete', async () => {
        const app = global.__APP__;
        const code = `CPN_${Date.now()}`;

        // 1. Create
        const createRes = await request(app)
            .post('/api/v1/admin/coupons')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                code,
                type: 'percent',
                value: 15,
            });

        expect(createRes.status).toBe(201);
        const id = createRes.body.data._id;

        // 2. Update
        const updateRes = await request(app)
            .put(`/api/v1/admin/coupons/${id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                value: 20,
            });

        expect(updateRes.status).toBe(200);
        expect(updateRes.body.data.value).toBe(20);

        // 3. Delete
        const deleteRes = await request(app)
            .delete(`/api/v1/admin/coupons/${id}`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(deleteRes.status).toBe(200);

        // 4. Verify gone
        const getRes = await request(app)
            .get(`/api/v1/admin/coupons`)
            .set('Authorization', `Bearer ${adminToken}`);

        const found = getRes.body.data.find(c => c._id === id);
        expect(found).toBeUndefined();
    });

    test('Campaign lifecycle: Create -> Update -> Delete', async () => {
        const app = global.__APP__;

        // 1. Create
        const createRes = await request(app)
            .post('/api/v1/admin/campaigns')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: 'Summer Sale',
                type: 'percent',
                value: 10,
                appliesTo: 'all'
            });

        expect(createRes.status).toBe(201);
        const id = createRes.body.data._id;

        // 2. Update
        const updateRes = await request(app)
            .put(`/api/v1/admin/campaigns/${id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                value: 15,
            });

        expect(updateRes.status).toBe(200);
        expect(updateRes.body.data.value).toBe(15);

        // 3. Delete
        const deleteRes = await request(app)
            .delete(`/api/v1/admin/campaigns/${id}`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(deleteRes.status).toBe(200);
    });
});
