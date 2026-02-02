const request = require('supertest');
const { createUser, issueTokenForUser } = require('./helpers/factory.cjs');

async function importFreshApp({ nodeEnv, metricsEnabled }) {
  process.env.NODE_ENV = nodeEnv;
  process.env.ENABLE_METRICS = metricsEnabled ? 'true' : 'false';

  // cache-bust ESM import by adding a query param
  const stamp = Date.now();
  try {
    const mod = await import(process.cwd() + `/src/app.js?qa=${stamp}`);
    return mod.app || mod.default || mod;
  } catch {
    const mod = await import(process.cwd() + `/app.js?qa=${stamp}`);
    return mod.app || mod.default || mod;
  }
}

describe('Observability: /metrics exposure', () => {
  test('in production: /metrics requires admin auth when ENABLE_METRICS=true', async () => {
    const app = await importFreshApp({ nodeEnv: 'production', metricsEnabled: true });

    const unauth = await request(app).get('/metrics');
    expect([401, 403]).toContain(unauth.status);

    const admin = await createUser({ role: 'admin', email: `admin_m_${Date.now()}@example.com` });
    const token = await issueTokenForUser(admin);

    const ok = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(typeof ok.text).toBe('string');
    expect(ok.text).toContain('http');
  });

  test('in non-production: /metrics is open when ENABLE_METRICS=true', async () => {
    const app = await importFreshApp({ nodeEnv: 'test', metricsEnabled: true });

    const res = await request(app).get('/metrics').expect(200);
    expect(typeof res.text).toBe('string');
  });
});
