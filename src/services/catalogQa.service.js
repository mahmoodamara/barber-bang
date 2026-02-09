import { Product } from "../models/Product.js";

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function normalizeString(value) {
  return String(value || "").trim();
}

function countFilledSpecs(specs) {
  const fields = [
    "batteryMah",
    "chargingTimeMin",
    "runtimeMin",
    "voltageV",
    "powerW",
    "motorSpeedRpmMin",
    "motorSpeedRpmMax",
    "speedModes",
    "waterproofRating",
    "displayType",
    "bladeMaterial",
    "foilMaterial",
    "chargingType",
    "usageMode",
  ];

  let filled = 0;
  for (const key of fields) {
    const val = specs?.[key];
    if (typeof val === "number" && Number.isFinite(val)) filled += 1;
    if (typeof val === "string" && val.trim()) filled += 1;
  }

  return { filled, total: fields.length, fields };
}

function getPublishContentStatus(publishContent) {
  const bulletsHe = Array.isArray(publishContent?.bulletsHe) ? publishContent.bulletsHe : [];
  const bulletsAr = Array.isArray(publishContent?.bulletsAr) ? publishContent.bulletsAr : [];
  const bulletCount = [...bulletsHe, ...bulletsAr].filter((b) => normalizeString(b)).length;
  const shortDescHe = normalizeString(publishContent?.shortDescHe);
  const shortDescAr = normalizeString(publishContent?.shortDescAr);
  const hasShortDesc = Boolean(shortDescHe || shortDescAr);

  return { bulletCount, hasShortDesc };
}

export async function generateCatalogQaReport(productId) {
  if (!productId) throw makeErr(400, "MISSING_PRODUCT_ID", "productId is required");

  const product = await Product.findById(productId).lean();
  if (!product) throw makeErr(404, "NOT_FOUND", "Product not found");

  const modelStr = normalizeString(product.identity?.model);
  const isModelVerified = product.verification?.isModelVerified === true;
  const isCategoryVerified = product.verification?.isCategoryVerified === true;
  const verifiedSourcesCount = Number(product.verification?.verifiedSourcesCount || 0);
  const hasCriticalMismatch = product.verification?.hasCriticalMismatch === true;

  const { filled: specsFilled, total: specsTotal, fields: specFields } = countFilledSpecs(
    product.specs
  );
  const { bulletCount, hasShortDesc } = getPublishContentStatus(product.publishContent);

  const critical_issues = [];
  const missing_fields = [];
  const contradictions = [];
  const field_level_fixes = [];
  const recommended_additions = [];

  if (!modelStr) {
    critical_issues.push("Missing model");
    missing_fields.push("identity.model");
    field_level_fixes.push({
      field: "identity.model",
      current: "",
      suggested: "Provide verified model",
      reason: "Required to publish",
    });
  }

  if (!isCategoryVerified) {
    critical_issues.push("Category not verified");
    missing_fields.push("verification.isCategoryVerified");
    field_level_fixes.push({
      field: "verification.isCategoryVerified",
      current: false,
      suggested: true,
      reason: "Category must be verified for publish",
    });
  }

  if (hasCriticalMismatch) {
    critical_issues.push("Critical category mismatch flagged");
    contradictions.push("Category mismatch flagged");
  }

  if (verifiedSourcesCount < 2) {
    missing_fields.push("verification.verifiedSourcesCount");
    recommended_additions.push("Add at least two verified sources");
  }

  if (specsFilled === 0) {
    for (const key of specFields) missing_fields.push(`specs.${key}`);
    recommended_additions.push("Add verified core specs");
  } else if (specsFilled / specsTotal <= 0.5) {
    recommended_additions.push("Add remaining verified specs");
  }

  if (bulletCount < 3) {
    missing_fields.push("publishContent.bulletsHe");
    missing_fields.push("publishContent.bulletsAr");
    recommended_additions.push("Add at least 3 bullets in one language");
  }

  if (!hasShortDesc) {
    missing_fields.push("publishContent.shortDescHe");
    missing_fields.push("publishContent.shortDescAr");
    recommended_additions.push("Add short description in one language");
  }

  let compatibility_score = 0;
  if (isModelVerified) compatibility_score += 20;
  if (isCategoryVerified) compatibility_score += 20;
  if (verifiedSourcesCount >= 2) compatibility_score += 15;
  if (specsFilled / specsTotal > 0.5) compatibility_score += 15;
  if (bulletCount >= 3 && hasShortDesc) compatibility_score += 15;
  if (!hasCriticalMismatch) compatibility_score += 15;
  compatibility_score = Math.max(0, Math.min(100, Math.round(compatibility_score)));

  let decision = "READY";
  if (!modelStr || !isCategoryVerified || hasCriticalMismatch) {
    decision = "HOLD";
  } else if (bulletCount < 3 || !hasShortDesc) {
    decision = "READY_WITH_EDITS";
  }

  return {
    compatibility_score,
    critical_issues,
    missing_fields,
    contradictions,
    field_level_fixes,
    recommended_additions,
    decision,
  };
}
