/**
 * qa/tests/auth.session.contract.test.cjs
 * Auth API contract: register, login, me (if exists), refresh, logout.
 * Skips gracefully when endpoints are not implemented.
 */

const request = require('supertest');
const {
  createUser,
  issueTokenForUser,
} = require('./helpers/factory.cjs');

const PASSWORD = 'P@ssw0rd!123';

describe('Auth session contract', () => {
  let userToken;
  let userEmail;

  beforeEach(async () => {
    const user = await createUser({ role: 'user', email: `auth_contract_${Date.now()}@test.com`, password: PASSWORD });
    userToken = await issueTokenForUser(user);
    userEmail = user.email;
  });

  describe('Registration', () => {
    test('POST /api/v1/auth/register returns 200 and ok=true', async () => {
      const app = global.__APP__;
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          name: 'E2E User',
          email: `e2e_register_${Date.now()}@test.com`,
          password: PASSWORD,
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('Login', () => {
    test('POST /api/v1/auth/login returns 200 and ok=true with token', async () => {
      const app = global.__APP__;
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: userEmail,
          password: PASSWORD,
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.token).toBeDefined();
      expect(typeof res.body.data.token).toBe('string');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    test('returns 401 without token', async () => {
      const app = global.__APP__;
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    });

    test('returns 200 with valid token and user data', async () => {
      const app = global.__APP__;
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.email).toBe(userEmail);
      expect(res.body.data.role).toBe('user');
      // Ensure no sensitive data is leaked
      expect(res.body.data.passwordHash).toBeUndefined();
      expect(res.body.data.password).toBeUndefined();
      expect(res.body.data.tokenVersion).toBeUndefined();
    });
  });

  describe('Refresh', () => {
    test('POST /api/v1/auth/refresh returns 200 when valid refresh token (if supported)', async () => {
      const app = global.__APP__;
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: userEmail, password: PASSWORD });

      const refreshToken = loginRes.body?.data?.refreshToken;
      if (!refreshToken) {
        return; // Login does not return refreshToken; skip
      }

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('Logout', () => {
    test('POST /api/v1/auth/logout returns 200 with valid token', async () => {
      const app = global.__APP__;
      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
