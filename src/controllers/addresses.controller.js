// src/controllers/addresses.controller.js
import { createAddressSchema, updateAddressSchema } from "../validators/address.validators.js";
import {
  listMyAddresses,
  addMyAddress,
  updateMyAddress,
  deleteMyAddress,
  setMyDefaultAddress,
} from "../services/address.service.js";

function pickAuth(req) {
  const a = req.auth || {};
  return { userId: a.userId || a.id || a._id, roles: a.roles || [] };
}

export async function listMine(req, res) {
  const auth = pickAuth(req);
  const items = await listMyAddresses({ auth });
  return res.status(200).json({ ok: true, items });
}

export async function createMine(req, res) {
  const auth = pickAuth(req);
  const body = req.validated?.body || createAddressSchema.parse(req.body || {});
  const out = await addMyAddress({ auth, body });
  return res.status(201).json({ ok: true, items: out.addresses, meta: { createdId: out.createdId } });
}

export async function updateMine(req, res) {
  const auth = pickAuth(req);
  const patch = req.validated?.body || updateAddressSchema.parse(req.body || {});
  const items = await updateMyAddress({ auth, addressId: req.params.id, patch });
  return res.status(200).json({ ok: true, items });
}

export async function deleteMine(req, res) {
  const auth = pickAuth(req);
  const items = await deleteMyAddress({ auth, addressId: req.params.id });
  return res.status(200).json({ ok: true, items });
}

export async function setDefault(req, res) {
  const auth = pickAuth(req);
  const items = await setMyDefaultAddress({ auth, addressId: req.params.id });
  return res.status(200).json({ ok: true, items });
}
