import mongoose from "mongoose";

const subscriberSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Invalid email"],
    },
    isActive: { type: Boolean, default: true },
    source: {
      type: String,
      default: "footer",
      enum: ["footer", "popup", "checkout", "api"],
    },
    lang: { type: String, default: "he", enum: ["he", "ar", "en"] },
  },
  { timestamps: true },
);

subscriberSchema.index({ email: 1 }, { unique: true });
subscriberSchema.index({ isActive: 1, createdAt: -1 });

export const NewsletterSubscriber = mongoose.model(
  "NewsletterSubscriber",
  subscriberSchema,
);
