/**
 * qa/tests/admin.categories.crud.e2e.test.cjs
 * Full CRUD for Admin Categories:
 * GET /admin/categories (list), GET /admin/categories/:id (read one),
 * POST /admin/categories (create), PUT /admin/categories/:id (update),
 * DELETE /admin/categories/:id (delete).
 * Covers auth, validation, and business rules (e.g. cannot delete if has products/children).
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { createUser, issueTokenForUser, createCategory, createProduct } = require('./helpers/factory.cjs');

const BASE = '/api/v1/admin/categories';

describe('Admin Categories CRUD E2E', () => {
  let adminToken;
  let app;

  beforeEach(async () => {
    app = global.__APP__;
    const admin = await createUser({ role: 'admin', email: `admin_cat_${Date.now()}@test.com` });
    adminToken = await issueTokenForUser(admin);
  }, 30000);

  describe('Auth', () => {
    test('all admin category endpoints require auth (401 without token)', async () => {
      await request(app).get(BASE).expect(401);
      await request(app).get(`${BASE}/507f1f77bcf86cd799439011`).expect(401);
      await request(app)
        .post(BASE)
        .send({ nameHe: 'Test' })
        .expect(401);
      await request(app)
        .put(`${BASE}/507f1f77bcf86cd799439011`)
        .send({ nameHe: 'Updated' })
        .expect(401);
      await request(app).delete(`${BASE}/507f1f77bcf86cd799439011`).expect(401);
    });
  });

  describe('List (GET /admin/categories)', () => {
    test('returns 200 with ok and data array and pagination meta', async () => {
      const res = await request(app)
        .get(BASE)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toBeDefined();
      expect(typeof res.body.meta.total).toBe('number');
      expect(typeof res.body.meta.pages).toBe('number');
    });

    test('accepts query params: page, limit, q, sortBy, sortDir', async () => {
      const res = await request(app)
        .get(BASE)
        .query({ page: 1, limit: 5, sortBy: 'createdAt', sortDir: 'desc' })
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Create (POST /admin/categories)', () => {
    test('returns 201 with created category (nameHe, slug, _id)', async () => {
      const nameHe = `קטגוריה CRUD ${Date.now()}`;
      const slug = `cat-crud-${Date.now()}`;
      const res = await request(app)
        .post(BASE)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          nameHe,
          nameAr: 'فئة',
          slug,
          isActive: true,
          sortOrder: 0,
        });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data._id).toBeDefined();
      expect(res.body.data.nameHe).toBe(nameHe);
      expect(res.body.data.slug).toBeDefined();
    });

    test('returns 400 when nameHe too short or missing', async () => {
      const res = await request(app)
        .post(BASE)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ nameHe: 'x' }); // min 2

      expect([400, 422]).toContain(res.status);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('Read one (GET /admin/categories/:id)', () => {
    test('returns 200 with category when id exists', async () => {
      const cat = await createCategory({ nameHe: 'קטגוריה לקריאה', nameAr: 'فئة للقراءة' });
      const id = cat._id.toString();

      const res = await request(app)
        .get(`${BASE}/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data._id).toBe(id);
      expect(res.body.data.nameHe).toBeDefined();
    });

    test('returns 404 when category does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .get(`${BASE}/${fakeId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.error?.code).toBeDefined();
    });

    test('returns 400 when id is invalid ObjectId', async () => {
      const res = await request(app)
        .get(`${BASE}/not-an-object-id`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('Update (PUT /admin/categories/:id)', () => {
    test('returns 200 with updated category', async () => {
      const cat = await createCategory({ nameHe: 'קטגוריה לעדכון', nameAr: 'فئة للتحديث' });
      const id = cat._id.toString();
      const newName = `עודכן ${Date.now()}`;

      const res = await request(app)
        .put(`${BASE}/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ nameHe: newName });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.nameHe).toBe(newName);
      expect(res.body.data._id).toBe(id);
    });

    test('returns 404 when category does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .put(`${BASE}/${fakeId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ nameHe: 'Updated' });

      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });

    test('returns 400 when no valid fields to update', async () => {
      const cat = await createCategory();
      const id = cat._id.toString();

      const res = await request(app)
        .put(`${BASE}/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('Delete (DELETE /admin/categories/:id)', () => {
    test('returns 200 and deletes category when no products or children', async () => {
      // Create a fresh category - since beforeEach clears all collections,
      // this category will have no products or child categories
      const cat = await createCategory({ nameHe: `למחיקה_${Date.now()}`, nameAr: 'للحذف' });
      const id = cat._id.toString();

      // Explicitly ensure no products or child categories reference this category
      const { Product } = await import(process.cwd() + '/src/models/Product.js');
      const { Category } = await import(process.cwd() + '/src/models/Category.js');
      await Product.deleteMany({ categoryId: new mongoose.Types.ObjectId(id) });
      await Category.deleteMany({ parentId: new mongoose.Types.ObjectId(id) });

      const res = await request(app)
        .delete(`${BASE}/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Debug: if 409, log what's blocking
      if (res.status === 409) {
        const prodCount = await Product.countDocuments({ categoryId: new mongoose.Types.ObjectId(id) });
        const childCount = await Category.countDocuments({ parentId: new mongoose.Types.ObjectId(id) });
        console.log(`[DEBUG] 409 for category ${id}: products=${prodCount}, children=${childCount}, error=${res.body.error?.code}`);
      }

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data?.deleted).toBe(true);
      expect(res.body.data?.id).toBeDefined();

      const getRes = await request(app)
        .get(`${BASE}/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(getRes.status).toBe(404);
    });

    test('returns 404 when category does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .delete(`${BASE}/${fakeId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });

    test('returns 409 when category has products (CATEGORY_HAS_PRODUCTS)', async () => {
      const cat = await createCategory({ nameHe: 'קטגוריה עם מוצרים', nameAr: 'فئة بمنتجات' });
      const categoryId = cat._id.toString();
      await createProduct({ categoryId, titleHe: 'מוצר', price: 10, stock: 5 });

      const res = await request(app)
        .delete(`${BASE}/${categoryId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
      expect(res.body.error?.code).toBe('CATEGORY_HAS_PRODUCTS');
    });

    test('returns 400 when id is invalid ObjectId', async () => {
      const res = await request(app)
        .delete(`${BASE}/bad-id`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('Full CRUD flow', () => {
    test('create -> list includes it -> get by id -> update -> get reflects update -> delete -> get 404', async () => {
      const nameHe = `Full CRUD ${Date.now()}`;
      const slug = `full-crud-${Date.now()}`;

      const createRes = await request(app)
        .post(BASE)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ nameHe, slug, isActive: true });
      expect(createRes.status).toBe(201);
      const id = createRes.body.data._id;

      const listRes = await request(app)
        .get(BASE)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(listRes.status).toBe(200);
      const foundInList = listRes.body.data.find((c) => String(c._id) === String(id));
      expect(foundInList).toBeDefined();

      const getRes = await request(app)
        .get(`${BASE}/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.nameHe).toBe(nameHe);

      const updatedName = `${nameHe} (updated)`;
      const updateRes = await request(app)
        .put(`${BASE}/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ nameHe: updatedName });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.nameHe).toBe(updatedName);

      const getAfterRes = await request(app)
        .get(`${BASE}/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(getAfterRes.status).toBe(200);
      expect(getAfterRes.body.data.nameHe).toBe(updatedName);

      // Explicitly ensure no products or child categories reference this category
      const { Product } = await import(process.cwd() + '/src/models/Product.js');
      const { Category } = await import(process.cwd() + '/src/models/Category.js');
      await Product.deleteMany({ categoryId: new mongoose.Types.ObjectId(id) });
      await Category.deleteMany({ parentId: new mongoose.Types.ObjectId(id) });

      const deleteRes = await request(app)
        .delete(`${BASE}/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Debug: if 409, log what's blocking
      if (deleteRes.status === 409) {
        const prodCount = await Product.countDocuments({ categoryId: new mongoose.Types.ObjectId(id) });
        const childCount = await Category.countDocuments({ parentId: new mongoose.Types.ObjectId(id) });
        console.log(`[DEBUG] 409 for category ${id}: products=${prodCount}, children=${childCount}, error=${deleteRes.body.error?.code}`);
      }

      expect(deleteRes.status).toBe(200);

      const getGoneRes = await request(app)
        .get(`${BASE}/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(getGoneRes.status).toBe(404);
    });
  });
});
