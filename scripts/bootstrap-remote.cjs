// One-off bootstrap for a REMOTE (Atlas) database. Unlike bootstrap-local.cjs this
// does not require a loopback URI. It only upserts built-in roles and creates the
// owner + empty restaurant if missing — it never overwrites existing data.
// Run: RESTAURANT_ENV_FILE=.env.local node scripts/bootstrap-remote.cjs
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '..', process.env.RESTAURANT_ENV_FILE || '.env.local') });

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('MONGODB_URI missing in env file'); process.exit(1); }
const password = process.env.LOCAL_OWNER_PASSWORD;
if (!password || password.length < 16) { console.error('LOCAL_OWNER_PASSWORD must be >= 16 chars'); process.exit(1); }

const mongoose = require('mongoose');
const { RoleModel } = require('../dist/modules/roles/role.model');
const { UserModel } = require('../dist/modules/users/user.model');
const { RestaurantModel } = require('../dist/modules/restaurant/restaurant.model');
const { OrderRequestModel } = require('../dist/modules/orders/orderRequest.service');
const { BUILT_IN_ROLES } = require('../dist/modules/roles/builtInRoles');
const { hashPassword } = require('../dist/modules/auth/token.service');

(async () => {
  await mongoose.connect(uri);
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName) throw new Error('MongoDB must be a replica set (Atlas is).');
  await OrderRequestModel.init();
  for (const role of BUILT_IN_ROLES) await RoleModel.updateOne({ key: role.key }, { $setOnInsert: role }, { upsert: true });
  const role = await RoleModel.findOne({ key: 'owner' });
  const email = process.env.LOCAL_OWNER_EMAIL || 'owner@pinky.local';
  if (!(await UserModel.exists({ email })))
    await UserModel.create({ email, name: process.env.LOCAL_OWNER_NAME || 'Pinky Promise Owner', passwordHash: await hashPassword(password), roleId: role._id, isActive: true });
  if (!(await RestaurantModel.exists({ singleton: 'main' }))) await RestaurantModel.create({ singleton: 'main' });
  const r = await RestaurantModel.findOne({ singleton: 'main' });
  console.log(`Remote bootstrap done. Owner: ${email} | currency: ${r.currency} | roles: ${BUILT_IN_ROLES.length}`);
  await mongoose.disconnect();
})().catch(async (e) => { console.error('BOOTSTRAP ERROR:', e.message); await mongoose.disconnect(); process.exitCode = 1; });
