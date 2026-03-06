import mongoose from "mongoose";

const savedListItemSchema = new mongoose.Schema(
  {
    listId: { type: mongoose.Schema.Types.ObjectId, ref: "SavedList", required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    variantId: { type: String, default: "", trim: true, maxlength: 64 },
    qty: { type: Number, required: true, min: 1, max: 9999 },
  },
  {
    timestamps: true,
    collection: "saved_list_items",
  },
);

savedListItemSchema.index({ listId: 1, createdAt: 1 });
savedListItemSchema.index({ listId: 1, productId: 1, variantId: 1 }, { unique: true });

export const SavedListItem = mongoose.model("SavedListItem", savedListItemSchema);
