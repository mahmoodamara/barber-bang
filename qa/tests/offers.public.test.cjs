const request = require('supertest');

describe('Offers Public API', () => {
    test('GET /api/v1/offers represents public deals', async () => {
        const app = global.__APP__;
        const res = await request(app).get('/api/v1/offers/active');

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
    });
});
