// src/api/routes/webhooks.routes.js
import { Router } from "express";
import express from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { handleStripeWebhook } from "../../controllers/webhooks.controller.js";

const router = Router();

router.post(
  "/stripe",
  express.raw({ type: "application/json", limit: "1mb" }),
  asyncHandler(handleStripeWebhook),
);

export default router;
