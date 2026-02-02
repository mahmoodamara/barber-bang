const request = require('supertest');

describe('Orders Tracking', () => {
    test('POST /api/v1/orders/track returns 404 for non-existent order', async () => {
        const app = global.__APP__;

        // We don't need to create a real order to test the contract of "order not found"
        const res = await request(app)
            .post('/api/v1/orders/track')
            .send({
                orderNumber: 'BB-9999-999999',
                phone: '0500000000'
            });

        expect(res.status).toBe(404);
        expect(res.body.ok).toBe(false);
    });

    // Note: To test success, we'd need to mock or enable the Order Service to create an order first.
    // Given standard clean setup, just validating the endpoint exists and handles input is good.
});
