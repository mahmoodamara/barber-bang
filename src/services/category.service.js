import mongoose from "mongoose";
import { Category } from "../models/Category.js";
import { normalizeSlug, joinFullSlug } from "../utils/slug.js";
import { withOptionalTransaction } from "../utils/mongoTx.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import {
  getCategoryTreeCache,
  setCategoryTreeCache,
  clearCategoryCaches,
} from "../utils/categoryCache.js";

function toObjectId(id) {
  return id ? new mongoose.Types.ObjectId(id) : null;
}

async function getParent(parentId) {
  if (!parentId) return null;
  const parent = await applyQueryBudget(
    Category.findOne({ _id: parentId, isDeleted: { $ne: true } }),
  );
  if (!parent) {
    const err = new Error("PARENT_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }
  return parent;
}

export async function createCategory(payload) {
  const slug = normalizeSlug(payload.slug);
  const parentId = payload.parentId ? toObjectId(payload.parentId) : null;

  const parent = await getParent(parentId);

  const fullSlug = joinFullSlug(parent?.fullSlug || "", slug);
  const ancestors = parent ? [...parent.ancestors, parent._id] : [];
  const level = parent ? parent.level + 1 : 0;

  const doc = await Category.create({
    nameHe: payload.nameHe,
    nameAr: payload.nameAr,
    slug,
    fullSlug,
    parentId,
    ancestors,
    level,
    sortOrder: payload.sortOrder ?? 0,
    isActive: payload.isActive ?? true,
  });
  clearCategoryCaches();
  return doc;
}

export async function updateCategory(categoryId, patch) {
  return withOptionalTransaction(async (session) => {
    const cat = await applyQueryBudget(
      Category.findOne({ _id: categoryId, isDeleted: { $ne: true } }).session(
        session || undefined,
      ),
    );
    if (!cat) {
      const err = new Error("CATEGORY_NOT_FOUND");
      err.statusCode = 404;
      throw err;
    }

    const old = {
      fullSlug: cat.fullSlug,
      parentId: cat.parentId?.toString() || null,
      ancestors: [...(cat.ancestors || [])].map((x) => x.toString()),
      level: cat.level,
      slug: cat.slug,
    };

    if (patch.nameHe !== undefined) cat.nameHe = patch.nameHe;
    if (patch.nameAr !== undefined) cat.nameAr = patch.nameAr;
    if (patch.sortOrder !== undefined) cat.sortOrder = patch.sortOrder;
    if (patch.isActive !== undefined) cat.isActive = patch.isActive;

    let changedPath = false;

    if (patch.slug !== undefined) {
      const newSlug = normalizeSlug(patch.slug);
      if (newSlug !== cat.slug) {
        cat.slug = newSlug;
        changedPath = true;
      }
    }

    if (patch.parentId !== undefined) {
      const newParentId = patch.parentId ? toObjectId(patch.parentId) : null;
      const oldParentId = cat.parentId ? cat.parentId.toString() : null;

      if ((newParentId?.toString() || null) !== oldParentId) {
        if (newParentId && newParentId.toString() === cat._id.toString()) {
          const err = new Error("CATEGORY_CYCLE");
          err.statusCode = 400;
          throw err;
        }
        if (newParentId) {
          const parentDoc = await applyQueryBudget(
            Category.findOne({ _id: newParentId, isDeleted: { $ne: true } }).session(
              session || undefined,
            ),
          );
          if (!parentDoc) {
            const err = new Error("PARENT_NOT_FOUND");
            err.statusCode = 404;
            throw err;
          }
          const isDescendant = parentDoc.ancestors?.some((a) => a.toString() === cat._id.toString());
          if (isDescendant) {
            const err = new Error("CATEGORY_CYCLE");
            err.statusCode = 400;
            throw err;
          }
        }

        cat.parentId = newParentId;
        changedPath = true;
      }
    }

    if (changedPath) {
      const parent = cat.parentId
        ? await applyQueryBudget(
            Category.findOne({ _id: cat.parentId, isDeleted: { $ne: true } }).session(
              session || undefined,
            ),
          )
        : null;

      cat.ancestors = parent ? [...parent.ancestors, parent._id] : [];
      cat.level = parent ? parent.level + 1 : 0;
      cat.fullSlug = joinFullSlug(parent?.fullSlug || "", cat.slug);
    }

    await cat.save({ session: session || undefined });

    if (changedPath) {
      const currentId = cat._id.toString();
      const oldPrefix = old.fullSlug;
      const newPrefix = cat.fullSlug;

      const descendants = await applyQueryBudget(
        Category.find({
          ancestors: new mongoose.Types.ObjectId(currentId),
        }).session(session || undefined),
      );

      if (descendants.length) {
        const bulk = descendants.map((d) => {
          const fullSlug = String(d.fullSlug || "");
          const suffix = fullSlug.startsWith(oldPrefix) ? fullSlug.slice(oldPrefix.length) : "";
          const nextFullSlug = `${newPrefix}${suffix}`;

          const anc = (d.ancestors || []).map((x) => x.toString());
          const idx = anc.indexOf(currentId);
          const tail = idx >= 0 ? anc.slice(idx + 1) : [];
          const nextAncestors = [...cat.ancestors.map((x) => x.toString()), currentId, ...tail].map(
            (x) => new mongoose.Types.ObjectId(x),
          );

          const deltaLevel = cat.level - old.level;
          const nextLevel = Math.max(0, (d.level || 0) + deltaLevel);

          return {
            updateOne: {
              filter: { _id: d._id },
              update: { $set: { fullSlug: nextFullSlug, ancestors: nextAncestors, level: nextLevel } },
            },
          };
        });

        await Category.bulkWrite(bulk, { session: session || undefined });
      }
    }

    clearCategoryCaches();
    return cat;
  });
}

export async function softDeleteCategory(categoryId) {
  const cat = await applyQueryBudget(
    Category.findOne({ _id: categoryId, isDeleted: { $ne: true } }),
  );
  if (!cat) {
    const err = new Error("CATEGORY_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }
  cat.isActive = false;
  cat.isDeleted = true;
  cat.deletedAt = new Date();
  await cat.save();
  clearCategoryCaches();
  return cat;
}

export async function listCategoriesAdmin({ parentId, includeInactive = true }) {
  const q = {};
  if (parentId !== undefined) q.parentId = parentId ? toObjectId(parentId) : null;
  q.isDeleted = { $ne: true };
  if (!includeInactive) q.isActive = true;

  return applyQueryBudget(Category.find(q).sort({ sortOrder: 1, createdAt: 1 }).lean());
}

export async function listCategoriesTree({ onlyActive = true } = {}) {
  const cacheKey = onlyActive ? "active" : "all";
  const cached = getCategoryTreeCache(cacheKey);
  if (cached) return cached;

  const q = onlyActive ? { isActive: true } : {};
  q.isDeleted = { $ne: true };
  const cats = await applyQueryBudget(
    Category.find(q).sort({ level: 1, sortOrder: 1, createdAt: 1 }).lean(),
  );

  const byId = new Map();
  const roots = [];

  for (const c of cats) {
    const node = { ...c, children: [] };
    byId.set(String(c._id), node);
  }

  for (const c of cats) {
    const node = byId.get(String(c._id));
    const pid = c.parentId ? String(c.parentId) : null;
    if (!pid) roots.push(node);
    else {
      const parent = byId.get(pid);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  setCategoryTreeCache(cacheKey, roots);
  return roots;
}
