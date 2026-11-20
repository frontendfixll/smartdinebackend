// Run after npm run build with QR_TEST_MONGO set to a disposable local replica set.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const uri = process.env.QR_TEST_MONGO;
if (!uri || !/^mongodb:\/\/(localhost|127\.0\.0\.1):\d+\//.test(uri))
  throw Error('Set QR_TEST_MONGO to a local MongoDB replica set');
Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGODB_URI: uri,
  QR_SERVICE_ZONES: 'Terrace',
  QR_SERVICE_MODE: 'live',
  JWT_ACCESS_SECRET: 'local-integration-access',
  JWT_REFRESH_SECRET: 'local-integration-refresh',
  JWT_GUEST_SECRET: 'local-integration-guest',
});
const mongoose = require('mongoose');
const request = require('supertest');
const { createApp } = require('../dist/app');
const { signAccessToken } = require('../dist/modules/auth/token.service');
const { codeMatches, joinCode } = require('../dist/modules/tableService/membership');
const { TableSessionModel } = require('../dist/modules/tables/tableSession.model');
const { TableModel } = require('../dist/modules/tables/table.model');
const { QrCodeModel } = require('../dist/modules/qr/qrCode.model');
const { ItemModel } = require('../dist/modules/menu/item.model');
const { OrderModel } = require('../dist/modules/orders/order.model');
const { UserModel } = require('../dist/modules/users/user.model');
const { RoleModel } = require('../dist/modules/roles/role.model');
const { ShiftModel } = require('../dist/modules/shifts/shift.model');
const { getOrCreateRestaurant } = require('../dist/modules/restaurant/restaurant.service');
const app = request(createApp());
const base = '/api/v1';
const service = base + '/table-service';
const dbName = 'test_qr_' + randomUUID().replaceAll('-', '');
async function main() {
  await mongoose.connect(uri, { dbName });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const restaurant = await getOrCreateRestaurant();
  restaurant.tax.taxes = [{ name: 'Test tax', type: 'other', rate: 0, applyOn: 'subtotal' }];
  await restaurant.save();
  const dish = await ItemModel.create({
    name: 'Noodles',
    slug: 'noodles',
    categoryId: new mongoose.Types.ObjectId(),
    basePrice: 5,
    foodType: 'veg',
  });
  const role = await RoleModel.create({
    key: 'waiter',
    name: 'Waiter',
    permissions: ['table:read', 'table:update', 'kds:update', 'reservation:update'],
  });
  const user = await UserModel.create({
    name: 'Mira Patel',
    email: 'waiter@example.test',
    passwordHash: 'test',
    roleId: role._id,
  });
  const staff = 'Bearer ' + signAccessToken({ sub: String(user._id), roleKey: 'waiter' });
  const shift = await ShiftModel.create({
    userId: user._id,
    startedAt: new Date(),
    maxServiceTables: 1,
    maxServiceCovers: 4,
    serviceZone: 'Terrace',
  });
  const tables = await TableModel.create([
    { number: '12', zone: 'Terrace', capacity: 4 },
    { number: '14', zone: 'Terrace', capacity: 4 },
  ]);
  await QrCodeModel.create(
    tables.map((t) => ({
      slug: 'test-' + t.number,
      type: 'table',
      tableId: t._id,
      label: t.number,
    })),
  );
  const qr = 'test-12';
  const scan = () =>
    app
      .get(service + '/entry')
      .query({ qr })
      .expect(200);
  await Promise.all([scan(), scan()]);
  assert.equal(await TableSessionModel.countDocuments(), 0);
  const arrive = () =>
    app
      .post(service + '/arrivals')
      .send({ qr, covers: 4 })
      .expect(200);
  await Promise.all([arrive(), arrive()]);
  await app
    .post(service + '/arrivals')
    .send({ qr, covers: 2 })
    .expect(409);
  const seat = (t) =>
    app
      .post(base + '/table-sessions')
      .set('Authorization', staff)
      .send({ tableId: t._id, guestCount: 4 });
  const seating = await Promise.all([seat(tables[0]), seat(tables[0]), seat(tables[1])]);
  assert.deepEqual(seating.map((r) => r.status).sort(), [201, 201, 409]);
  assert.equal(await TableSessionModel.countDocuments({ waiterId: user._id }), 1);
  assert.equal(await TableSessionModel.countDocuments({ qrService: true }), 2);
  console.log('PASS simultaneous arrivals, seating and waiter capacity');
  const visit = await TableSessionModel.findOne({ tableId: tables[0]._id });
  const info = await app
    .get(service + '/visits/' + visit.id)
    .set('Authorization', staff)
    .expect(200);
  const { code } = info.body.data;
  assert(!codeMatches(visit.id, joinCode(visit.id, 0), 32 * 60_000));
  const join = () =>
    app
      .post(service + '/join')
      .send({ qr, code })
      .expect(200);
  const phones = await Promise.all([join(), join()]);
  const [first, second] = phones.map((r) => r.body.data.grant);
  assert.notEqual(first, second);
  assert.equal((await TableSessionModel.findById(visit.id)).guestCount, 4);
  const water = (token) =>
    app
      .post(service + '/requests')
      .set('X-Visit-Token', token)
      .send({ qr, type: 'water', key: randomUUID() })
      .expect(200);
  const [a, b] = await Promise.all([water(first), water(second)]);
  assert.equal(a.body.data.id, b.body.data.id);
  const task = service + '/tasks/' + a.body.data.id;
  await app.post(task).set('Authorization', staff).send({ state: 'acknowledged' }).expect(200);
  await app.post(task).set('Authorization', staff).send({ state: 'completed' }).expect(200);
  const progress = await app
    .get(service + '/current')
    .query({ qr })
    .set('X-Visit-Token', second)
    .expect(200);
  assert.equal(progress.body.data.tasks[0].state, 'completed');
  console.log('PASS two phones, four covers, one water request before ordering, staff fulfillment');
  const order = (token) =>
    app
      .post(base + '/guest/orders/dine-in')
      .set('Idempotency-Key', randomUUID())
      .set('X-Visit-Token', token)
      .send({ qrSlug: qr, maxTotal: 100, items: [{ itemId: dish._id, qty: 1 }] });
  await order('').expect(403);
  const receipt = await order(first).expect(201);
  const orderId = receipt.body.data.id;
  const item = receipt.body.data.items[0].id;
  assert.equal((await OrderModel.findById(orderId)).qrService, true);
  const step = (status) =>
    app
      .patch(base + '/kds/orders/' + orderId + '/items/' + item + '/status')
      .set('Authorization', staff)
      .send({ status });
  await step('preparing').expect(200);
  await step('ready').expect(200);
  await step('served').expect(409);
  const pass = service + '/pass/' + orderId + '/' + item;
  await app.post(pass).set('Authorization', staff).send({ action: 'pickup' }).expect(200);
  await app.post(pass).set('Authorization', staff).send({ action: 'pickup' }).expect(200);
  await app.post(pass).set('Authorization', staff).send({ action: 'serve' }).expect(200);
  await app.post(pass).set('Authorization', staff).send({ action: 'serve' }).expect(200);
  assert.equal((await OrderModel.findById(orderId)).status, 'served');
  await app
    .post(base + '/table-sessions/' + visit.id + '/close')
    .set('Authorization', staff)
    .expect(409);
  // Simulate a finalized, paid bill. The billing suite verifies payment processing.
  await OrderModel.updateOne(
    { _id: orderId },
    { $set: { status: 'settled', paymentStatus: 'paid' } },
  );
  console.log(
    'PASS verified checkout, pickup replay, delivery confirmation and open-bill close guard',
  );
  await app
    .post(base + '/table-sessions/' + visit.id + '/close')
    .set('Authorization', staff)
    .expect(200);
  assert.equal((await TableModel.findById(tables[0]._id)).status, 'cleaning');
  await app
    .get(service + '/current')
    .query({ qr })
    .set('X-Visit-Token', first)
    .expect(403);
  await TableModel.updateOne({ _id: tables[0]._id }, { $set: { status: 'vacant' } });
  await ShiftModel.updateOne({ _id: shift._id }, { $push: { breaks: { startedAt: new Date() } } });
  await seat(tables[0]).expect(201);
  assert.equal(
    (await TableSessionModel.findOne({ tableId: tables[0]._id, status: 'open' })).waiterId,
    undefined,
  );
  await order(first).expect(403);
  await app
    .post(service + '/join')
    .send({ qr, code })
    .expect(403);
  console.log('PASS cleaning, shift break, copied QR, old code and grant rejected after turnover');
  const nextWaiter = await UserModel.create({
    name: 'Dev Shah',
    email: 'dev@example.test',
    passwordHash: 'test',
    roleId: role._id,
  });
  await ShiftModel.create({
    userId: nextWaiter._id,
    startedAt: new Date(),
    serviceZone: 'Terrace',
  });
  const nextStaff = 'Bearer ' + signAccessToken({ sub: nextWaiter.id, roleKey: 'waiter' });
  const unassigned = await TableSessionModel.findOne({ tableId: tables[0]._id, status: 'open' });
  const assign = (who, payload) =>
    app
      .post(service + '/visits/' + unassigned.id + '/assign')
      .set('Authorization', who)
      .send(payload);
  await assign(staff, { previous: null, version: 0 }).expect(200);
  await ShiftModel.updateOne(
    { _id: shift._id },
    { $set: { breaks: [], maxServiceTables: 4, maxServiceCovers: 20 } },
  );
  const offer = { previous: nextWaiter.id, version: 1, waiterId: user.id };
  await assign(nextStaff, offer).expect(200);
  assert.equal(String((await TableSessionModel.findById(unassigned._id)).waiterId), nextWaiter.id);
  await assign(nextStaff, offer).expect(409);
  await assign(staff, { ...offer, version: 2 }).expect(200);
  assert.equal(String((await TableSessionModel.findById(unassigned._id)).waiterId), user.id);
  const table3 = await TableModel.create({ number: '16', zone: 'Terrace', capacity: 4 });
  const { ReservationModel } = require('../dist/modules/reservations/reservation.model');
  const booking = await ReservationModel.create({
    restaurantId: restaurant._id,
    guestName: 'Test party',
    partySize: 3,
    status: 'confirmed',
    tableId: table3._id,
    reservedAt: new Date(),
    endsAt: new Date(Date.now() + 3600000),
  });
  await seat(table3).expect(409);
  await app
    .post(base + '/reservations/' + booking.id + '/check-in')
    .set('Authorization', staff)
    .send({})
    .expect(200);
  const booked = await TableSessionModel.findOne({ tableId: table3._id });
  assert.equal(booked.guestCount, 3);
  assert.ok(booked.waiterId);
  assert.ok(booked.qrService);
  process.env.QR_SERVICE_MODE = 'shadow';
  const table4 = await TableModel.create({ number: '18', zone: 'Terrace', capacity: 4 });
  await seat(table4).expect(201);
  const shadow = await TableSessionModel.findOne({ tableId: table4._id });
  assert.ok(shadow.suggestedWaiterId);
  assert.equal(shadow.waiterId, undefined);
  assert.equal(shadow.qrService, undefined);
  console.log(
    'PASS handover acceptance, stale action rejection, reservation seating and shadow mode',
  );
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
