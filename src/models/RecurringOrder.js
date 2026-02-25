import mongoose from "mongoose";

const recurringItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true, min: 1, max: 9999 },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const recurringOrderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, maxlength: 200 },

    items: { type: [recurringItemSchema], required: true, validate: [(v) => v.length > 0, "At least one item required"] },

    frequency: {
      type: String,
      enum: ["weekly", "biweekly", "monthly", "bimonthly", "quarterly"],
      required: true,
    },

    isActive: { type: Boolean, default: true },

    nextRunAt: { type: Date, required: true },
    lastRunAt: { type: Date, default: null },
    lastOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },

    shippingMode: { type: String, enum: ["DELIVERY", "PICKUP_POINT", "STORE_PICKUP"], default: "DELIVERY" },
    deliveryAreaId: { type: String, default: "" },
    pickupPointId: { type: String, default: "" },
  },
  { timestamps: true },
);

recurringOrderSchema.index({ userId: 1, isActive: 1 });
recurringOrderSchema.index({ isActive: 1, nextRunAt: 1 });

export const RecurringOrder = mongoose.model("RecurringOrder", recurringOrderSchema);
