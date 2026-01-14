import mongoose from "mongoose";

export function getOrCreateModel(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

export function baseToJSON(schema) {
  schema.set("toJSON", {
    virtuals: true,
    versionKey: false,
    transform(_doc, ret) {
      ret.id = ret._id?.toString?.() || ret.id;
      delete ret._id;
      return ret;
    },
  });
}
