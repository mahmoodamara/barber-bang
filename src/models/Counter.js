// src/models/Counter.js
import mongoose from "mongoose";

const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    year: { type: Number, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

counterSchema.index({ key: 1, year: 1 }, { unique: true });

export const Counter = mongoose.model("Counter", counterSchema);
