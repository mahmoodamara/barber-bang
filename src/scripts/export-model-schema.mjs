import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Export Mongoose model schemas (fields + indexes + relations) from /src/models
 * Works best when each model file registers itself via mongoose.model(...)
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const MODELS_DIR = path.resolve(PROJECT_ROOT, "src", "models");

// CHANGE THIS if your project uses a different folder name.
if (!fs.existsSync(MODELS_DIR)) {
  console.error("❌ Models dir not found:", MODELS_DIR);
  process.exit(1);
}

function isModelFile(name) {
  return (
    name.endsWith(".js") ||
    name.endsWith(".mjs") ||
    name.endsWith(".ts")
  );
}

function safeStringify(obj) {
  return JSON.stringify(obj, null, 2);
}

function extractFieldMeta(schema) {
  // schema.paths includes _id, __v etc.
  const out = {};
  for (const [key, p] of Object.entries(schema.paths)) {
    // Skip internal keys
    // keep _id if you want it documented
    if (key === "__v") continue;

    const instance = p.instance; // String, Number, Date, ObjectID, Array, Mixed...
    const options = p.options || {};

    const meta = {
      type: instance,
      required: !!options.required,
      default:
        typeof options.default === "function"
          ? "[Function]"
          : options.default ?? null,
      enum: options.enum ?? null,
      ref: options.ref ?? null,
      unique: !!options.unique,
      index: !!options.index,
      select: options.select ?? null,
      immutable: options.immutable ?? null,
      min: options.min ?? null,
      max: options.max ?? null,
      minlength: options.minlength ?? null,
      maxlength: options.maxlength ?? null,
    };

    // ObjectId arrays often show as "Array" with caster instance
    if (instance === "Array" && p.caster) {
      meta.itemsType = p.caster.instance || null;
      meta.itemsRef = p.caster?.options?.ref || null;
    }

    out[key] = meta;
  }
  return out;
}

function extractIndexes(schema) {
  // returns array: [ [fields], options ]
  return schema.indexes().map(([fields, options]) => ({
    fields,
    options,
  }));
}

function extractRelations(fields) {
  // Any field with ref or array itemsRef is a relation
  const rels = [];
  for (const [name, meta] of Object.entries(fields)) {
    if (meta.ref) {
      rels.push({
        field: name,
        type: meta.type,
        ref: meta.ref,
        cardinality: meta.type === "ObjectID" ? "many-to-one" : "unknown",
      });
    }
    if (meta.itemsRef) {
      rels.push({
        field: name,
        type: "Array",
        ref: meta.itemsRef,
        cardinality: "one-to-many",
      });
    }
  }
  return rels;
}

async function main() {
  // Dynamically import all model files to register mongoose models
  const entries = fs.readdirSync(MODELS_DIR).filter(isModelFile);

  // Import models
  for (const file of entries) {
    const full = path.join(MODELS_DIR, file);
    try {
      await import(pathToFileURL(full).href);
    } catch (e) {
      // Some projects use index.js to register all models; if so, you can import that instead
      console.warn(`⚠️ Could not import model file ${file}:`, e?.message || e);
    }
  }

  // Import mongoose AFTER loading models (works in most setups)
  // If your server exports mongoose elsewhere, adjust.
  const mongoose = await import("mongoose");

  const models = mongoose.default?.models || mongoose.models;
  const result = {};

  for (const [modelName, model] of Object.entries(models)) {
    const schema = model.schema;
    const fields = extractFieldMeta(schema);
    const indexes = extractIndexes(schema);
    const relations = extractRelations(fields);

    result[modelName] = {
      modelName,
      collection: model.collection?.name || null,
      fields,
      indexes,
      relations,
      timestamps: !!schema.options.timestamps,
    };
  }

  // Output JSON
  const outJson = path.resolve(PROJECT_ROOT, "model-schema.json");
  fs.writeFileSync(outJson, safeStringify(result), "utf-8");

  // Output Markdown
  const outMd = path.resolve(PROJECT_ROOT, "model-schema.md");
  const lines = [];
  lines.push(`# Model Schema Export`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  for (const modelName of Object.keys(result).sort()) {
    const m = result[modelName];
    lines.push(`## ${modelName}`);
    lines.push(`- Collection: \`${m.collection}\``);
    lines.push(`- Timestamps: \`${m.timestamps}\``);
    lines.push("");

    lines.push(`### Fields`);
    lines.push(`| Field | Type | Required | Ref | Unique | Index | Enum | Default |`);
    lines.push(`|------|------|----------|-----|--------|-------|------|---------|`);

    for (const [field, meta] of Object.entries(m.fields)) {
      const enumVal = meta.enum ? JSON.stringify(meta.enum) : "";
      const defVal = meta.default === null ? "" : String(meta.default);
      const refVal = meta.ref || meta.itemsRef || "";
      const typeVal =
        meta.type === "Array" && meta.itemsType
          ? `Array<${meta.itemsType}>`
          : meta.type;

      lines.push(
        `| \`${field}\` | \`${typeVal}\` | \`${meta.required}\` | \`${refVal}\` | \`${meta.unique}\` | \`${meta.index}\` | ${enumVal} | ${defVal} |`
      );
    }

    lines.push("");
    lines.push(`### Indexes`);
    if (!m.indexes.length) {
      lines.push(`(none)`);
    } else {
      for (const idx of m.indexes) {
        lines.push(`- Fields: \`${JSON.stringify(idx.fields)}\` Options: \`${JSON.stringify(idx.options)}\``);
      }
    }

    lines.push("");
    lines.push(`### Relations`);
    if (!m.relations.length) {
      lines.push(`(none)`);
    } else {
      for (const r of m.relations) {
        lines.push(`- \`${r.field}\` → \`${r.ref}\` (${r.cardinality})`);
      }
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  fs.writeFileSync(outMd, lines.join("\n"), "utf-8");

  console.log("✅ Exported:");
  console.log(" - model-schema.json");
  console.log(" - model-schema.md");
}

main().catch((e) => {
  console.error("❌ Failed:", e);
  process.exit(1);
});
