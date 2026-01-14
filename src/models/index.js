// src/models/index.js (ESM)
// Purpose:
// - Ensure ALL models are registered (via side-effect imports)
// - Re-export named models for convenient importing elsewhere

import "./User.js";
import "./Category.js";
import "./Product.js";
import "./Variant.js";
import "./Order.js";
import "./Coupon.js";
import "./CouponRedemption.js";
import "./CouponUserUsage.js";
import "./Promotion.js";
import "./PromotionRedemption.js";
import "./PromotionUserUsage.js";
import "./StockLog.js";
import "./StockReservation.js";
import "./StripeEvent.js";
import "./Job.js";
import "./Invoice.js";
import "./AuditLog.js";
import "./EmailOtpToken.js";

// Add missing models (from your folder list)
import "./AlertLog.js";
import "./RefundRequest.js";
import "./FeatureFlag.js";
import "./ReadModel.js";
import "./ReturnRequest.js";
import "./NotificationLog.js";

import "./RateLimitBucket.js";
import "./IdempotencyRecord.js";
import "./LeaseLock.js";

import "./Wishlist.js";
import "./Review.js";
import "./ShippingMethod.js";
import "./Cart.js";


export { RateLimitBucket } from "./RateLimitBucket.js";
export { IdempotencyRecord } from "./IdempotencyRecord.js";
export { LeaseLock } from "./LeaseLock.js";

export { User } from "./User.js";
export { Category } from "./Category.js";
export { Product } from "./Product.js";
export { Variant } from "./Variant.js";
export { Order } from "./Order.js";

export { Coupon } from "./Coupon.js";
export { CouponRedemption } from "./CouponRedemption.js";
export { CouponUserUsage } from "./CouponUserUsage.js";
export { Promotion } from "./Promotion.js";
export { PromotionRedemption } from "./PromotionRedemption.js";
export { PromotionUserUsage } from "./PromotionUserUsage.js";

export { StockLog } from "./StockLog.js";
export { StockReservation } from "./StockReservation.js";
export { StripeEvent } from "./StripeEvent.js";

export { Job } from "./Job.js";
export { Invoice } from "./Invoice.js";

export { AuditLog } from "./AuditLog.js";
export { EmailOtpToken } from "./EmailOtpToken.js";

// Export missing models
export { AlertLog } from "./AlertLog.js";
export { RefundRequest } from "./RefundRequest.js";

// Phase 5 exports
export { FeatureFlag } from "./FeatureFlag.js";
export { ReadModel } from "./ReadModel.js";
export { ReturnRequest } from "./ReturnRequest.js";
export { NotificationLog } from "./NotificationLog.js";

export { Wishlist } from "./Wishlist.js";
export { Review } from "./Review.js";
export { ShippingMethod } from "./ShippingMethod.js";
export { Cart } from "./Cart.js";
