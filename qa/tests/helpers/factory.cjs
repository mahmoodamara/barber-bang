const bcrypt = require('bcryptjs');

async function importModel(name) {
  try {
    const mod = await import(process.cwd() + `/src/models/${name}.js`);
    return mod[name];
  } catch {
    const mod = await import(process.cwd() + `/models/${name}.js`);
    return mod[name];
  }
}

async function importJwt() {
  try {
    return await import(process.cwd() + '/src/utils/jwt.js');
  } catch {
    return await import(process.cwd() + '/utils/jwt.js');
  }
}

function randEmail() {
  return `qa_${Date.now()}_${Math.random().toString(16).slice(2)}@example.com`;
}

async function createUser({
  role = 'user',
  permissions = [],
  email = null,
  password = 'P@ssw0rd!123',
  name = 'Test User',
} = {}) {
  const User = await importModel('User');
  const passwordHash = await bcrypt.hash(password, 10);
  const doc = await User.create({
    name,
    email: email || randEmail(),
    passwordHash,
    role,
    permissions,
  });
  return doc;
}

async function issueTokenForUser(user) {
  const { signToken } = await importJwt();
  return signToken({
    sub: String(user._id),
    tokenVersion: Number(user.tokenVersion || 0),
    role: user.role,
  });
}

async function createCategory({ nameHe = 'קטגוריה', nameAr = 'فئة' } = {}) {
  const Category = await importModel('Category');
  return Category.create({ nameHe, nameAr });
}

async function createProduct({
  categoryId,
  titleHe = 'מוצר',
  titleAr = 'منتج',
  price = 100,
  stock = 10,
  trackInventory = true,
  variants = [],
} = {}) {
  const Product = await importModel('Product');
  return Product.create({
    titleHe,
    titleAr,
    price,
    stock,
    trackInventory,
    categoryId,
    variants,
    isActive: true,
  });
}

async function setSiteSettings({ pricesIncludeVat = true } = {}) {
  const SiteSettings = await importModel('SiteSettings');
  // singleton-ish: create one doc
  return SiteSettings.create({ pricingRules: { pricesIncludeVat } });
}

async function createDeliveryArea({
  nameHe = 'תל אביב',
  nameAr = 'تل أبيب',
  fee = 0,
  isActive = true,
} = {}) {
  const DeliveryArea = await importModel('DeliveryArea');
  return DeliveryArea.create({ nameHe, nameAr, fee, isActive });
}

async function createCoupon({
  code = 'SAVE10',
  type = 'percent',
  value = 10,
  isActive = true,
  usageLimit = 1,
  usagePerUser = 1,
} = {}) {
  const Coupon = await importModel('Coupon');
  return Coupon.create({
    code,
    type,
    value,
    isActive,
    usageLimit,
    usagePerUser,
  });
}

module.exports = {
  createUser,
  issueTokenForUser,
  createCategory,
  createProduct,
  setSiteSettings,
  createDeliveryArea,
  createCoupon,
};
