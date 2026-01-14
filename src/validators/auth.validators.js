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

const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(200)
  .refine((val) => !isCommonPassword(val), { message: "Password is too common" });

export const registerSchema = z.object({
  body: z
    .object({
      email: z.string().email().max(254),
      password: passwordSchema,
      phone: z.string().max(30).optional(),
    })
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
    }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(200),
  }),
});
