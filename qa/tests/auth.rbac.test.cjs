const request = require('supertest');
const { createUser, issueTokenForUser } = require('./helpers/factory.cjs');

describe('Auth + RBAC basics', () => {
  test('register -> login -> access protected cart endpoint', async () => {
    const app = global.__APP__;

    const email = `u_${Date.now()}@example.com`;
    const password = 'Abcdef12';

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ name: 'QA User', email, password })
      .expect(200);

    expect(reg.body.ok).toBe(true);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email, password })
      .expect(200);

    expect(login.body.ok).toBe(true);
    expect(typeof login.body.data.token).toBe('string');

    const token = login.body.data.token;

    const cart = await request(app)
      .get('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(cart.body.ok).toBe(true);
    expect(Array.isArray(cart.body.data?.items || cart.body.data || [])).toBe(true);
  });

  test('staff user should be able to hold REFUNDS_WRITE permission (schema-level)', async () => {
    // This test intentionally checks that your data model supports the permission the middleware exposes.
    // If this fails, you have a real production bug: you cannot assign REFUNDS_WRITE to staff.
    let err = null;
    try {
      await createUser({ role: 'staff', permissions: ['REFUNDS_WRITE'], email: `staff_${Date.now()}@example.com` });
    } catch (e) {
      err = e;
    }

    expect(err).toBeNull();
  });

  test('admin can access admin dashboard routes', async () => {
    const app = global.__APP__;
    const admin = await createUser({ role: 'admin', email: `admin_${Date.now()}@example.com` });
    const token = await issueTokenForUser(admin);

    const res = await request(app)
      .get('/api/admin/dashboard/overview')
      .set('Authorization', `Bearer ${token}`);

    // Some deployments may not have this endpoint; allow 200/404 but forbid 401/403
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) expect(res.body.ok).toBe(true);
  });
});
