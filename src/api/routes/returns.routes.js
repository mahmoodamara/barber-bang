import { Router } from "express";

import { requireAuth } from "../../middlewares/auth.js";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

import {
  createReturnRequest,
  listMyReturns,
  getMyReturn,
  cancelReturn,
} from "../../controllers/returns.controller.js";

import {
  createReturnRequestSchema,
  listMyReturnsQuerySchema,
  returnIdParamsSchema,
  cancelReturnParamsSchema,
} from "../../validators/return.validators.js";

const router = Router();

router.use(requireAuth);

const useValidatedBodyForIdempotency = (req, _res, next) => {
  const vb = req?.validated?.body;
  if (vb && typeof vb === "object" && !Array.isArray(vb)) req.body = vb;
  next();
};

/* ------------------------------------------------------------------ */
/* Returns (Customer)                                                 */
/* Mounted at: /api/v1/returns                                        */
/* ------------------------------------------------------------------ */

router.post(
  "/",
  endpointLimiterMongo({
    scope: "returns:create",
    windowMs: 60_000,
    max: 30,
    messageCode: "RETURNS_RATE_LIMIT",
  }),
  validate(createReturnRequestSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "returns:create", required: true }),
  asyncHandler(createReturnRequest),
);

router.get(
  "/",
  endpointLimiterMongo({
    scope: "returns:list",
    windowMs: 60_000,
    max: 180,
    messageCode: "RETURNS_RATE_LIMIT",
  }),
  validate(listMyReturnsQuerySchema),
  asyncHandler(listMyReturns),
);

router.get(
  "/:id",
  endpointLimiterMongo({
    scope: "returns:get",
    windowMs: 60_000,
    max: 240,
    messageCode: "RETURNS_RATE_LIMIT",
  }),
  validate(returnIdParamsSchema),
  asyncHandler(getMyReturn),
);

router.post(
  "/:id/cancel",
  endpointLimiterMongo({
    scope: "returns:cancel",
    windowMs: 60_000,
    max: 60,
    messageCode: "RETURNS_RATE_LIMIT",
  }),
  validate(cancelReturnParamsSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "returns:cancel", required: true }),
  asyncHandler(cancelReturn),
);

export default router;

