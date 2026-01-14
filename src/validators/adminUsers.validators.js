import { z } from "zod";

import { boolFromQuery, objectId } from "./common.validators.js";
import { UserRoles } from "../models/User.js";

const roleEnum = z.enum([UserRoles.USER, UserRoles.STAFF, UserRoles.ADMIN]);

const sortEnum = z
  .string()
  .trim()
  .max(60)
  .regex(/^-?(createdAt|email|name|lastLoginAt)$/);

export const adminListUsersQuerySchema = z
  .object({
    query: z
      .object({
        page: z.coerce.number().int().min(1).optional().default(1),
        limit: z.coerce.number().int().min(1).max(100).optional().default(20),
        q: z.string().trim().max(120).optional(),
        role: roleEnum.optional(),
        isActive: boolFromQuery.optional(),
        emailVerified: boolFromQuery.optional(),
        sort: sortEnum.optional(),
      }),
  });

export const adminUserIdParamsSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
  });

export const adminUpdateUserSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        role: roleEnum.optional(),
        isActive: z.boolean().optional(),
        emailVerified: z.boolean().optional(),
        permissions: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
        segments: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
      })
      .strict()
      .superRefine((body, ctx) => {
        const hasAny =
          body.role !== undefined ||
          body.isActive !== undefined ||
          body.emailVerified !== undefined ||
          body.permissions !== undefined ||
          body.segments !== undefined;
        if (!hasAny) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [],
            message: "EMPTY_UPDATE",
          });
        }
      }),
  });

export const adminResetUserPasswordSchema = z
  .object({
    params: z.object({ id: objectId }).strict(),
    body: z.object({}).strict().default({}),
  });
