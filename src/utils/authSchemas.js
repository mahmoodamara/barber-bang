import { z } from "zod";

const COMMON_PASSWORDS = new Set([
  "password",
  "123456",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty",
  "qwerty123",
  "111111",
  "000000",
  "password1",
  "iloveyou",
  "admin",
  "letmein",
  "welcome",
  "abc123",
  "monkey",
  "dragon",
  "sunshine",
  "football",
  "princess",
]);

function isCommonPassword(value) {
  return COMMON_PASSWORDS.has(String(value || "").trim().toLowerCase());
}

const emailSchema = z.string().trim().email().max(254);

const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(200)
  .refine((val) => !isCommonPassword(val), { message: "Password is too common" });

const emptyBodySchema = z.object({}).strict().default({});

function wrapBody(schema) {
  return z
    .object({
      body: schema,
      query: z.any().optional(),
      params: z.any().optional(),
      headers: z.any().optional(),
    })
    .strict();
}

const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    phone: z.string().trim().max(30).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const email = String(val.email || "").toLowerCase();
    const local = email.split("@")[0] || "";
    const pwd = String(val.password || "").toLowerCase();
    if (local.length >= 3 && pwd.includes(local)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: "Password should not contain your email",
      });
    }
  });

export const authSchemas = {
  register: wrapBody(registerSchema),
  login: wrapBody(
    z
      .object({
        email: emailSchema,
        password: z.string().min(1).max(200),
      })
      .strict(),
  ),
  refresh: wrapBody(emptyBodySchema),
  logout: wrapBody(emptyBodySchema),
  logoutAll: wrapBody(emptyBodySchema),
  forgotPassword: wrapBody(z.object({ email: emailSchema }).strict()),
  resetPassword: wrapBody(
    z
      .object({
        token: z.string().trim().min(32).max(256),
        password: passwordSchema,
      })
      .strict(),
  ),
  verifyEmailOtp: wrapBody(
    z
      .object({
        email: emailSchema,
        code: z.string().trim().regex(/^\d{6}$/),
      })
      .strict(),
  ),
  resendEmailOtp: wrapBody(z.object({ email: emailSchema }).strict()),
};
