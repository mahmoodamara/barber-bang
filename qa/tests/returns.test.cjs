const request = require('supertest');
const { createUser, issueTokenForUser } = require('./helpers/factory.cjs');

describe('Returns API', () => {
    let userToken;

    beforeEach(async () => {
        const user = await createUser({ role: 'user', email: `returns_user_${Date.now()}@test.com` });
        userToken = await issueTokenForUser(user);
    }, 30000);

    test('POST /api/v1/returns requires auth', async () => {
        const app = global.__APP__;
        const res = await request(app)
            .post('/api/v1/returns')
            .send({ orderId: 'fake', items: [] });

        expect(res.status).toBe(401);
    });

    test('POST /api/v1/returns works with auth (logic may fail on bad ID)', async () => {
        const app = global.__APP__;
        // Using a fake mongo ID format
        const fakeOrderId = '609c12345678901234567890';

        const res = await request(app)
            .post('/api/v1/returns')
            .set('Authorization', `Bearer ${userToken}`)
            .send({
                orderId: fakeOrderId,
                reason: 'defective',
                items: []
            });

        // Should not be 401. 
        // Likely 404 (Order not found) or 400 (Bad request)
        expect(res.status).not.toBe(401);
        expect([200, 201, 400, 404]).toContain(res.status);
    });
});
