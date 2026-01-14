import mongoose from "mongoose";
const { Schema } = mongoose;

const FeatureFlagSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },

    rolesAllow: { type: [String], default: [] },
    allowUserIds: { type: [Schema.Types.ObjectId], default: [] },

    rollout: { type: Number, default: 0 }, // 0..100
    description: { type: String, default: "" },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

export const FeatureFlag =
  mongoose.models.FeatureFlag || mongoose.model("FeatureFlag", FeatureFlagSchema);
