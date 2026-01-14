// src/validators/address.validators.js
import { z } from "zod";

export const createAddressSchema = z.object({
  label: z.string().trim().max(60).optional().default(""),
  fullName: z.string().trim().max(120).optional().default(""),
  phone: z.string().trim().max(30).optional().default(""),

  country: z.string().trim().max(80).optional().default("Israel"),
  city: z.string().trim().max(120).min(1),
  street: z.string().trim().max(200).min(1),
  building: z.string().trim().max(50).optional().default(""),
  apartment: z.string().trim().max(50).optional().default(""),
  zip: z.string().trim().max(30).optional().default(""),
  notes: z.string().trim().max(500).optional().default(""),

  isDefault: z.boolean().optional().default(false),
});

export const updateAddressSchema = createAddressSchema.partial().omit({ isDefault: true });
