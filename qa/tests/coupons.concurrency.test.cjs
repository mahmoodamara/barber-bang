const mongoose = require('mongoose');
const { createUser, createCoupon } = require('./helpers/factory.cjs');

async function importReserve() {
  try {
    return await import(process.cwd() + '/src/services/pricing.service.js');
  } catch {
    return await import(process.cwd() + '/services/pricing.service.js');
  }
}

function oid() {
  return new mongoose.Types.ObjectId().toString();
}

describe('Coupons: concurrency safety for usageLimit and usagePerUser', () => {
  test('usageLimit=1 should allow only 1 reserve across concurrent orders', async () => {
    const { reserveCouponAtomic } = await importReserve();

    const coupon = await createCoupon({ code: 'ONCE', usageLimit: 1, usagePerUser: 10 });

    // 10 different orders compete for the same coupon
    const results = await Promise.all(
      Array.from({ length: 10 }).map(() => reserveCouponAtomic({
        code: 'ONCE',
        orderId: oid(),
        userId: null,
        ttlMinutes: 15,
      }))
    );

    const ok = results.filter(r => r && r.success && (r.reserved || r.alreadyReserved)).length;

    // STRICT expectation: should be exactly 1 when race-safe.
    expect(ok).toBe(1);
  });

  test('usagePerUser=1 should allow only 1 reserve for same user under concurrency', async () => {
    const { reserveCouponAtomic } = await importReserve();

    await createCoupon({ code: 'USERONCE', usageLimit: 100, usagePerUser: 1 });
    const user = await createUser({ role: 'user' });

    const results = await Promise.all(
      Array.from({ length: 10 }).map(() => reserveCouponAtomic({
        code: 'USERONCE',
        orderId: oid(),
        userId: String(user._id),
        ttlMinutes: 15,
      }))
    );

    const ok = results.filter(r => r && r.success && (r.reserved || r.alreadyReserved)).length;
    expect(ok).toBe(1);
  });

  test('no counter drift after release: reserve then release leaves reservedCount at 0', async () => {
    const { reserveCouponAtomic, releaseCouponReservation } = await importReserve();
    const Coupon = (await import(process.cwd() + '/src/models/Coupon.js')).Coupon;

    const coupon = await createCoupon({
      code: 'RELEASETEST',
      usageLimit: 2,
      usagePerUser: 10,
    });
    const orderIdA = oid();

    const reserveResult = await reserveCouponAtomic({
      code: 'RELEASETEST',
      orderId: orderIdA,
      userId: null,
      ttlMinutes: 15,
    });
    expect(reserveResult.success).toBe(true);
    expect(reserveResult.reserved).toBe(true);

    const released = await releaseCouponReservation({
      code: 'RELEASETEST',
      orderId: orderIdA,
    });
    expect(released.success).toBe(true);

    const couponAfter = await Coupon.findOne({ code: 'RELEASETEST' }).lean();
    expect(couponAfter.reservedCount).toBe(0);

    // Reserve again for a different order: should succeed and reservedCount becomes 1
    const orderIdB = oid();
    const reserveAgain = await reserveCouponAtomic({
      code: 'RELEASETEST',
      orderId: orderIdB,
      userId: null,
      ttlMinutes: 15,
    });
    expect(reserveAgain.success).toBe(true);
    expect(reserveAgain.reserved).toBe(true);

    const couponFinal = await Coupon.findOne({ code: 'RELEASETEST' }).lean();
    expect(couponFinal.reservedCount).toBe(1);
  });
});
