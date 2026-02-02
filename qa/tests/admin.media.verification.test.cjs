/**
 * Verification: Admin media routes
 * - Route ordering: /config and /orphans must NOT be shadowed by /:id
 * - Auth: 401 without token, 403 without permission, 200 with permission
 * - GET /orphans must hit orphans handler (not /:id with id="orphans")
 */
const request = require('supertest');
const mongoose = require('mongoose');
const { createUser, issueTokenForUser } = require('./helpers/factory.cjs');

async function importMediaAsset() {
  try {
    const mod = await import(process.cwd() + '/src/models/MediaAsset.js');
    return mod.MediaAsset;
  } catch {
    return (await import(process.cwd() + '/models/MediaAsset.js')).MediaAsset;
  }
}

describe('Admin media: route ordering and auth', () => {
  const base = '/api/v1/admin/media';

  test('GET /config returns 401 without token', async () => {
    const app = global.__APP__;
    const res = await request(app).get(`${base}/config`);
    expect(res.status).toBe(401);
    expect(res.body?.error?.code).toBe('UNAUTHORIZED');
  });

  test('GET /config returns 403 without PRODUCTS_WRITE', async () => {
    const app = global.__APP__;
    const staff = await createUser({
      role: 'staff',
      permissions: ['ORDERS_WRITE'],
      email: `staff_no_media_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(staff);

    const res = await request(app)
      .get(`${base}/config`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  test('GET /config returns 200 with PRODUCTS_WRITE', async () => {
    const app = global.__APP__;
    const admin = await createUser({
      role: 'admin',
      email: `admin_media_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(admin);

    const res = await request(app)
      .get(`${base}/config`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(typeof res.body?.data?.configured).toBe('boolean');
    expect(typeof res.body?.data?.maxFileSizeBytes).toBe('number');
  });

  test('GET /orphans returns 401 without token', async () => {
    const app = global.__APP__;
    const res = await request(app).get(`${base}/orphans`);
    expect(res.status).toBe(401);
  });

  test('GET /orphans returns 403 without PRODUCTS_WRITE', async () => {
    const app = global.__APP__;
    const staff = await createUser({
      role: 'staff',
      permissions: ['ORDERS_WRITE'],
      email: `staff_no_media2_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(staff);

    const res = await request(app)
      .get(`${base}/orphans`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('GET /orphans hits orphans handler (NOT /:id) - returns list shape, not "Asset not found"', async () => {
    const app = global.__APP__;
    const admin = await createUser({
      role: 'admin',
      email: `admin_orphans_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(admin);

    const res = await request(app)
      .get(`${base}/orphans`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(Array.isArray(res.body?.data)).toBe(true);
    expect(res.body?.meta).toBeDefined();
    expect(res.body?.meta?.daysThreshold).toBeDefined();
    expect(res.body?.meta?.cutoffDate).toBeDefined();
    expect(res.body?.meta?.page).toBeDefined();
    expect(res.body?.meta?.limit).toBeDefined();
    expect(res.body?.meta?.total).toBeDefined();
    expect(res.body?.error?.message).not.toBe('Asset not found');
  });

  test('DELETE /orphans returns 401 without token', async () => {
    const app = global.__APP__;
    const res = await request(app)
      .delete(`${base}/orphans`)
      .send({ days: 7, dryRun: true });
    expect(res.status).toBe(401);
  });

  test('DELETE /orphans dryRun returns 200 with permission', async () => {
    const app = global.__APP__;
    const admin = await createUser({
      role: 'admin',
      email: `admin_del_orphans_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(admin);

    const res = await request(app)
      .delete(`${base}/orphans`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send({ days: 7, dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data?.dryRun).toBe(true);
    expect(typeof res.body?.data?.wouldDelete).toBe('number');
  });

  test('GET /:id with valid ObjectId returns 404 when not found (not 400)', async () => {
    const app = global.__APP__;
    const admin = await createUser({
      role: 'admin',
      email: `admin_getid_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(admin);
    const fakeId = new mongoose.Types.ObjectId();

    const res = await request(app)
      .get(`${base}/${fakeId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe('NOT_FOUND');
  });

  test('GET /:id with valid ObjectId returns 200 when asset exists', async () => {
    const app = global.__APP__;
    const MediaAsset = await importMediaAsset();
    const admin = await createUser({
      role: 'admin',
      email: `admin_getasset_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(admin);

    const asset = await MediaAsset.create({
      publicId: `qa_verif_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      url: 'https://example.com/img.jpg',
      secureUrl: 'https://example.com/img.jpg',
    });

    const res = await request(app)
      .get(`${base}/${asset._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data?.id).toBe(String(asset._id));
    expect(res.body?.data?.publicId).toBe(asset.publicId);
  });

  test('GET /:id with invalid id returns 400', async () => {
    const app = global.__APP__;
    const admin = await createUser({
      role: 'admin',
      email: `admin_invalid_${Date.now()}@example.com`,
    });
    const token = await issueTokenForUser(admin);

    const res = await request(app)
      .get(`${base}/not-a-valid-objectid`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('INVALID_ID');
  });
});
