import { User } from "../models/User.js";
import {
  forgotPassword as forgotPasswordService,
  issueEmailVerificationOtp,
  loginUser,
  logoutAllSessions,
  logoutSession,
  refreshSession,
  registerUser,
  resendEmailOtp as resendEmailOtpService,
  resetPassword as resetPasswordService,
  verifyEmailOtp as verifyEmailOtpService,
} from "../services/auth.service.js";
import {
  clearRefreshCookie,
  getRefreshTokenFromReq,
  setRefreshCookie,
} from "../utils/authTokens.js";
import { logger } from "../utils/logger.js";
import { ENV } from "../utils/env.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";

function authError(statusCode, code) {
  const err = new Error(code);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function normalizeEmailLower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getRequestMeta(req) {
  return {
    requestId: req.requestId,
    ip: req.ip || null,
    userAgent: req.get("user-agent") || "",
  };
}

function audit(event, req, details = {}) {
  const meta = getRequestMeta(req);
  logger.info(
    {
      event,
      requestId: meta.requestId,
      userId: details.userId || null,
      emailLower: details.emailLower || null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      outcome: details.outcome || "unknown",
    },
    `auth.${event}`,
  );
}

export async function register(req, res) {
  const body = req.validated?.body || req.body || {};
  const emailLower = normalizeEmailLower(body.email);
  try {
    const user = await registerUser({
      email: body.email,
      password: body.password,
      phone: body.phone,
    });

    try {
      await issueEmailVerificationOtp({
        user,
        ip: req.ip,
        userAgent: req.get("user-agent") || "",
        requestId: req.requestId,
      });
      audit("email_otp_sent", req, { userId: user.id, emailLower: user.emailLower, outcome: "success" });
    } catch {
      audit("email_otp_sent", req, { userId: user.id, emailLower: user.emailLower, outcome: "failed" });
    }

    audit("register", req, {
      userId: user.id,
      emailLower: user.emailLower || emailLower,
      outcome: "success",
    });

    // Audit log to DB
    await logAuditSuccess(req, AuditActions.AUTH_REGISTER, { type: "User", id: user.id });

    res.status(201).json({
      ok: true,
      user: { id: user.id, email: user.emailLower, roles: user.roles, emailVerified: false },
    });
  } catch (err) {
    audit("register", req, { emailLower, outcome: "failed" });
    await logAuditFail(req, AuditActions.AUTH_REGISTER, { type: "User" }, err);
    throw err;
  }
}

export async function login(req, res) {
  const body = req.validated?.body || req.body || {};
  const emailLower = normalizeEmailLower(body.email);
  const meta = getRequestMeta(req);

  try {
    const { user, token, refreshToken, refreshTtlMs } = await loginUser({
      email: body.email,
      password: body.password,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });

    setRefreshCookie(res, refreshToken, refreshTtlMs);

    audit("login_success", req, {
      userId: user.id,
      emailLower: user.emailLower || emailLower,
      outcome: "success",
    });

    // Audit log to DB
    await logAuditSuccess(req, AuditActions.AUTH_LOGIN, { type: "User", id: user.id });

    res.json({
      ok: true,
      token,
      user: { id: user.id, email: user.emailLower, roles: user.roles },
    });
  } catch (err) {
    audit("login_failed", req, { emailLower, outcome: "failed" });
    await logAuditFail(req, AuditActions.AUTH_LOGIN, { type: "User" }, err);
    throw err;
  }
}

export async function verifyEmailOtp(req, res) {
  const body = req.validated?.body || req.body || {};
  const emailLower = normalizeEmailLower(body.email);
  const meta = getRequestMeta(req);

  try {
    const { user } = await verifyEmailOtpService({
      email: body.email,
      code: body.code,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    audit("email_otp_verify_success", req, {
      userId: user?.id || null,
      emailLower: user?.emailLower || emailLower,
      outcome: "success",
    });

    await logAuditSuccess(req, AuditActions.AUTH_VERIFY_EMAIL_OTP, { type: "User", id: user?.id });

    res.json({ ok: true });
  } catch (err) {
    audit("email_otp_verify_failed", req, { emailLower, outcome: "failed" });
    await logAuditFail(req, AuditActions.AUTH_VERIFY_EMAIL_OTP, { type: "User" }, err);
    throw err;
  }
}

export async function resendEmailOtp(req, res) {
  const body = req.validated?.body || req.body || {};
  const emailLower = normalizeEmailLower(body.email);
  const meta = getRequestMeta(req);
  let result = null;

  try {
    result = await resendEmailOtpService({
      email: body.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });
    audit("email_otp_resend", req, { emailLower, outcome: "success" });
    await logAuditSuccess(req, AuditActions.AUTH_RESEND_EMAIL_OTP, { type: "User" });
  } catch (err) {
    audit("email_otp_resend", req, { emailLower, outcome: "failed" });
    await logAuditFail(req, AuditActions.AUTH_RESEND_EMAIL_OTP, { type: "User" }, err);
  }

  const response = { ok: true };
  if (ENV.NODE_ENV !== "production") {
    response.data = result?.mail || null;
  }
  res.json(response);
}

export async function refresh(req, res) {
  const refreshToken = getRefreshTokenFromReq(req);
  if (!refreshToken) {
    audit("refresh", req, { outcome: "failed" });
    await logAuditFail(req, AuditActions.AUTH_REFRESH, { type: "Session" }, { message: "No refresh token" });
    throw authError(401, "AUTH_REQUIRED");
  }

  const meta = getRequestMeta(req);
  try {
    const { user, token, refreshToken: nextToken, refreshTtlMs } = await refreshSession({
      refreshToken,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    setRefreshCookie(res, nextToken, refreshTtlMs);

    audit("refresh", req, {
      userId: user.id,
      emailLower: user.emailLower,
      outcome: "success",
    });

    await logAuditSuccess(req, AuditActions.AUTH_REFRESH, { type: "User", id: user.id });

    res.json({
      ok: true,
      token,
      user: { id: user.id, email: user.emailLower, roles: user.roles },
    });
  } catch (err) {
    clearRefreshCookie(res);
    audit("refresh", req, { outcome: "failed" });
    await logAuditFail(req, AuditActions.AUTH_REFRESH, { type: "Session" }, err);
    throw err;
  }
}

export async function logout(req, res) {
  const refreshToken = getRefreshTokenFromReq(req);
  try {
    const result = await logoutSession({ refreshToken });
    clearRefreshCookie(res);

    audit("logout", req, {
      userId: result.userId ? String(result.userId) : null,
      outcome: "success",
    });

    await logAuditSuccess(req, AuditActions.AUTH_LOGOUT, {
      type: "User",
      id: result.userId ? String(result.userId) : null,
    });

    res.json({ ok: true });
  } catch (err) {
    clearRefreshCookie(res);
    audit("logout", req, { outcome: "failed" });
    await logAuditFail(req, AuditActions.AUTH_LOGOUT, { type: "Session" }, err);
    throw err;
  }
}

export async function logoutAll(req, res) {
  const userId = req.auth?.userId;
  const emailLower = req.auth?.email ? normalizeEmailLower(req.auth.email) : null;

  try {
    const user = await logoutAllSessions({ userId });
    clearRefreshCookie(res);

    audit("logout_all", req, {
      userId: user.id,
      emailLower: user.emailLower || emailLower,
      outcome: "success",
    });

    await logAuditSuccess(req, AuditActions.AUTH_LOGOUT_ALL, { type: "User", id: user.id });

    res.json({ ok: true });
  } catch (err) {
    clearRefreshCookie(res);
    audit("logout_all", req, { userId, emailLower, outcome: "failed" });
    await logAuditFail(req, AuditActions.AUTH_LOGOUT_ALL, { type: "User", id: userId }, err);
    throw err;
  }
}

export async function forgotPassword(req, res) {
  const body = req.validated?.body || req.body || {};
  const emailLower = normalizeEmailLower(body.email);
  const meta = getRequestMeta(req);

  try {
    await forgotPasswordService({
      email: body.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    audit("forgot_password", req, { emailLower, outcome: "success" });
    await logAuditSuccess(req, AuditActions.AUTH_FORGOT_PASSWORD, { type: "User" });
    res.json({ ok: true });
  } catch (err) {
    audit("forgot_password", req, { emailLower, outcome: "failed" });
    await logAuditFail(req, AuditActions.AUTH_FORGOT_PASSWORD, { type: "User" }, err);
    throw err;
  }
}

export async function resetPassword(req, res) {
  const body = req.validated?.body || req.body || {};

  try {
    const { user } = await resetPasswordService({
      token: body.token,
      password: body.password,
    });

    audit("reset_password", req, {
      userId: user?.id || null,
      emailLower: user?.emailLower || null,
      outcome: "success",
    });

    await logAuditSuccess(req, AuditActions.AUTH_RESET_PASSWORD, { type: "User", id: user?.id });

    res.json({ ok: true });
  } catch (err) {
    audit("reset_password", req, { outcome: "failed" });
    await logAuditFail(req, AuditActions.AUTH_RESET_PASSWORD, { type: "User" }, err);
    throw err;
  }
}

export async function me(req, res) {
  const user = await User.findById(req.auth.userId).lean();
  if (!user) {
    const err = new Error("AUTH_INVALID");
    err.statusCode = 401;
    throw err;
  }
  res.json({
    ok: true,
    user: {
      id: String(user._id),
      email: user.emailLower,
      roles: user.roles,
      isActive: user.isActive,
    },
  });
}
