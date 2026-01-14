// src/services/address.service.js
import mongoose from "mongoose";
import { User } from "../models/index.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
}

const MAX_ADDRESSES = 10;

export async function listMyAddresses({ auth }) {
  const user = await User.findById(auth.userId).select("addresses").lean();
  if (!user) throw httpError(404, "USER_NOT_FOUND", "User not found");
  return user.addresses || [];
}

export async function addMyAddress({ auth, body }) {
  const user = await User.findById(auth.userId).select("addresses").exec();
  if (!user) throw httpError(404, "USER_NOT_FOUND", "User not found");

  const addresses = Array.isArray(user.addresses) ? user.addresses : [];
  if (addresses.length >= MAX_ADDRESSES) {
    throw httpError(409, "ADDRESS_LIMIT_REACHED", `Max addresses is ${MAX_ADDRESSES}`);
  }

  const isFirst = addresses.length === 0;
  const desiredDefault = Boolean(body.isDefault) || isFirst;

  if (desiredDefault) {
    for (const a of addresses) a.isDefault = false;
  }

  user.addresses.push({
    label: body.label || "",
    fullName: body.fullName || "",
    phone: body.phone || "",
    country: body.country || "Israel",
    city: body.city,
    street: body.street,
    building: body.building || "",
    apartment: body.apartment || "",
    zip: body.zip || "",
    notes: body.notes || "",
    isDefault: desiredDefault,
  });

  await user.save();

  const created = user.addresses[user.addresses.length - 1];
  return { createdId: String(created._id), addresses: user.addresses };
}

export async function updateMyAddress({ auth, addressId, patch }) {
  const user = await User.findOne({ _id: auth.userId, "addresses._id": addressId })
    .select("addresses")
    .exec();

  if (!user) throw httpError(404, "ADDRESS_NOT_FOUND", "Address not found");

  const addr = user.addresses.id(addressId);
  if (!addr) throw httpError(404, "ADDRESS_NOT_FOUND", "Address not found");

  for (const k of ["label", "fullName", "phone", "country", "city", "street", "building", "apartment", "zip", "notes"]) {
    if (patch[k] !== undefined) addr[k] = patch[k];
  }

  await user.save();
  return user.addresses;
}

export async function deleteMyAddress({ auth, addressId }) {
  const user = await User.findOne({ _id: auth.userId, "addresses._id": addressId })
    .select("addresses")
    .exec();

  if (!user) throw httpError(404, "ADDRESS_NOT_FOUND", "Address not found");

  const addr = user.addresses.id(addressId);
  if (!addr) throw httpError(404, "ADDRESS_NOT_FOUND", "Address not found");

  const wasDefault = Boolean(addr.isDefault);
  addr.deleteOne();

  if (wasDefault && user.addresses.length > 0) {
    user.addresses[0].isDefault = true;
  }

  await user.save();
  return user.addresses;
}

export async function setMyDefaultAddress({ auth, addressId }) {
  const uId = new mongoose.Types.ObjectId(auth.userId);
  const aId = new mongoose.Types.ObjectId(addressId);

  const res = await User.updateOne(
    { _id: uId, "addresses._id": aId },
    {
      $set: {
        "addresses.$[].isDefault": false,
        "addresses.$[target].isDefault": true,
      },
    },
    { arrayFilters: [{ "target._id": aId }] },
  );

  if (!res.matchedCount) throw httpError(404, "ADDRESS_NOT_FOUND", "Address not found");
  return listMyAddresses({ auth });
}
