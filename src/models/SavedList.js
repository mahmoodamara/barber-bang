import mongoose from "mongoose";

const savedListSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
  },
  {
    timestamps: true,
    collection: "saved_lists",
  },
);

savedListSchema.index({ userId: 1, createdAt: -1 });

export const SavedList = mongoose.model("SavedList", savedListSchema);
