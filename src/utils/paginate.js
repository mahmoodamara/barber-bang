export function parsePagination(query, { maxLimit = 50, defaultLimit = 20 } = {}) {
  const page = Math.max(1, Number(query.page || 1) || 1);
  const limitRaw = Number(query.limit || defaultLimit) || defaultLimit;
  const limit = Math.min(maxLimit, Math.max(1, limitRaw));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}
