import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
// REQUIRED: expose new auth endpoints for security upgrade.
import {
  authForgotPasswordLimiter,
  authLoginLimiter,
  authRegisterLimiter,
  authResendOtpLimiter,
  authVerifyOtpLimiter,
} from "../../middlewares/rateLimit.js";
import { authSchemas } from "../../utils/authSchemas.js";
import {
  forgotPassword,
  login,
  logout,
  logoutAll,
  me,
  refresh,
  register,
  resendEmailOtp,
  resetPassword,
  verifyEmailOtp,
} from "../../controllers/auth.controller.js";
import { requireAuth } from "../../middlewares/auth.js";

const router = Router();

router.post("/register", authRegisterLimiter, validate(authSchemas.register), asyncHandler(register));
router.post("/login", authLoginLimiter, validate(authSchemas.login), asyncHandler(login));
router.post("/refresh", validate(authSchemas.refresh), asyncHandler(refresh));
router.post("/logout", validate(authSchemas.logout), asyncHandler(logout));
router.post("/logout-all", requireAuth, validate(authSchemas.logoutAll), asyncHandler(logoutAll));
router.post(
  "/forgot-password",
  authForgotPasswordLimiter,
  validate(authSchemas.forgotPassword),
  asyncHandler(forgotPassword),
);
router.post("/reset-password", validate(authSchemas.resetPassword), asyncHandler(resetPassword));
router.post(
  "/verify-email-otp",
  authVerifyOtpLimiter,
  validate(authSchemas.verifyEmailOtp),
  asyncHandler(verifyEmailOtp),
);
router.post(
  "/resend-email-otp",
  authResendOtpLimiter,
  validate(authSchemas.resendEmailOtp),
  asyncHandler(resendEmailOtp),
);
router.get("/me", requireAuth, asyncHandler(me));

export default router;
