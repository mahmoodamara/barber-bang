// src/api/routes/addresses.routes.js
import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth } from "../../middlewares/auth.js";
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

import { createAddressSchema, updateAddressSchema } from "../../validators/address.validators.js";
import { listMine, createMine, updateMine, deleteMine, setDefault } from "../../controllers/addresses.controller.js";

const router = Router();

router.use(requireAuth);

router.get(
  "/",
  endpointLimiterMongo({ scope: "addresses:list", windowMs: 60_000, max: 60 }),
  asyncHandler(listMine),
);

router.post(
  "/",
  endpointLimiterMongo({ scope: "addresses:create", windowMs: 60_000, max: 20 }),
  validate(createAddressSchema),
  idempotencyEnforce({ routeName: "addresses:create", required: false }),
  asyncHandler(createMine),
);

router.patch(
  "/:id",
  endpointLimiterMongo({ scope: "addresses:update", windowMs: 60_000, max: 30 }),
  validate(updateAddressSchema),
  idempotencyEnforce({ routeName: "addresses:update", required: false }),
  asyncHandler(updateMine),
);

router.delete(
  "/:id",
  endpointLimiterMongo({ scope: "addresses:delete", windowMs: 60_000, max: 30 }),
  asyncHandler(deleteMine),
);

router.post(
  "/:id/default",
  endpointLimiterMongo({ scope: "addresses:set_default", windowMs: 60_000, max: 30 }),
  asyncHandler(setDefault),
);

export default router;
