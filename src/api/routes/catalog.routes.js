import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import {
  listCategoriesTree,
  listCategories,
  listBrands,
  catalogStats,
  homePayload,
  listProducts,
  getProduct,
} from "../../controllers/catalog.controller.js";
import { listProductsQuerySchema, getProductParamsSchema } from "../../validators/catalog.validators.js";

const router = Router();

router.get(
  "/categories/tree",
  (req, res, next) => {
    // مخرجات شبه ثابتة: 60s + SWR 5min
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    next();
  },
  asyncHandler(listCategoriesTree),
);


router.get(
  "/categories",
  (req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    next();
  },
  asyncHandler(listCategories),
);

router.get(
  "/brands",
  (req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    next();
  },
  asyncHandler(listBrands),
);

router.get(
  "/stats",
  (req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
    next();
  },
  asyncHandler(catalogStats),
);

router.get(
  "/home",
  (req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    next();
  },
  asyncHandler(homePayload),
);


router.get("/products", validate(listProductsQuerySchema), asyncHandler(listProducts));
router.get("/products/:idOrSlug", validate(getProductParamsSchema), asyncHandler(getProduct));

export default router;
