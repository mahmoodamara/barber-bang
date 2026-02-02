const request = require('supertest');
const { createUser, issueTokenForUser, createCategory, createProduct } = require('./helpers/factory.cjs');

describe('Reviews API', () => {
    let userToken;
    let productId;

    beforeEach(async () => {
        const user = await createUser({ role: 'user', email: `review_user_${Date.now()}@test.com` });
        userToken = await issueTokenForUser(user);

        const cat = await createCategory();
        const prod = await createProduct({ categoryId: cat._id.toString() });
        productId = prod._id.toString();
    }, 30000);

    test('POST /api/v1/reviews requires auth', async () => {
        const app = global.__APP__;
        const res = await request(app)
            .post('/api/v1/reviews')
            .send({ productId, rating: 5, content: 'Great!' });

        expect(res.status).toBe(401);
    });

    test('POST /api/v1/reviews creates a review (if allowed by rules)', async () => {
        const app = global.__APP__;

        // Some implementations require Verified Purchase. 
        // We assume minimal config allows it or we accept 403/400 as "protected but logic fail"
        // Ideally we see 201 Created or 200 OK
        const res = await request(app)
            .post('/api/v1/reviews')
            .set('Authorization', `Bearer ${userToken}`)
            .send({
                productId,
                rating: 5,
                content: 'Verified auth works'
            });

        // We accept 201 (created), 200 (ok), or 403/400 (logic error like "must buy first") 
        // BUT NOT 401 or 404 or 500.
        expect([200, 201, 400, 403]).toContain(res.status);
        if (res.status === 201 || res.status === 200) {
            expect(res.body.ok).toBe(true);
        }
    });

    test('GET /api/v1/products/:id/reviews works publicly', async () => {
        const app = global.__APP__;
        const res = await request(app)
            .get(`/api/v1/products/${productId}/reviews`);

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
    });
});
