const request = require('supertest');

describe('Stripe webhook basic contract', () => {
  test('missing stripe-signature header returns 400 INVALID_STRIPE_SIGNATURE', async () => {
    const app = global.__APP__;

    const res = await request(app)
      .post('/api/stripe/webhook')
      .set('Content-Type', 'application/json')
      .send({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_123' } } });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INVALID_STRIPE_SIGNATURE');
  });
});
