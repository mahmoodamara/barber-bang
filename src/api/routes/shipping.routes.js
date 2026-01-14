// src/api/routes/shipping.routes.js
import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { listPublic } from "../../controllers/shipping.controller.js";
import { listShippingMethodsQuerySchema } from "../../validators/shipping.validators.js";

const router = Router();

router.get(
  "/methods",
  endpointLimiterMongo({ scope: "shipping:methods_public", windowMs: 60_000, max: 120, messageCode: "RATE_LIMITED" }),
  validate(listShippingMethodsQuerySchema),
  asyncHandler(listPublic),
);

export default router;
