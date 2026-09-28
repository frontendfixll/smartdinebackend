/*
 * Rich local demo seed for Pinky Promise (USD / California).
 * Populates a realistic dataset so the app is not empty:
 *   restaurant config (hours + CA sales tax), staff, menu, tables/QR,
 *   inventory + recipes + supplier + purchase order, customers,
 *   ~3 weeks of settled orders with invoices + payments, live active
 *   orders on the floor, reservations and guest feedback.
 *
 * Safe for local only: refuses non-loopback databases. Clears and
 * rebuilds the demo collections (keeps roles + owner user).
 *
 * Run from backend/ after `npm run build`:
 *   node scripts/seed-rich-local.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env.local');
if (!fs.existsSync(envFile)) {
  console.error('Create backend/.env.local first.');
  process.exit(1);
}
const env = dotenv.parse(fs.readFileSync(envFile));
const uri = env.MONGODB_URI || '';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//.test(uri)) {
  console.error('Refusing to seed a non-loopback database.');
  process.exit(1);
}
// Apply local env before requiring compiled modules (dist/config validates process.env at import).
for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;

// Compiled models (built into dist/)
const d = (p) => require(path.join(root, 'dist', p));
const { RoleModel } = d('modules/roles/role.model');
const { UserModel } = d('modules/users/user.model');
const { RestaurantModel } = d('modules/restaurant/restaurant.model');
const { CategoryModel } = d('modules/menu/category.model');
const { ItemModel } = d('modules/menu/item.model');
const { ModifierGroupModel } = d('modules/menu/modifierGroup.model');
const { TableModel } = d('modules/tables/table.model');
const { QrCodeModel } = d('modules/qr/qrCode.model');
const { InventoryItemModel } = d('modules/inventory/inventoryItem.model');
const { RecipeModel } = d('modules/inventory/recipe.model');
const { StockMovementModel } = d('modules/inventory/stockMovement.model');
const { SupplierModel, PurchaseOrderModel } = d('modules/purchasing/purchasing.model');
const { CustomerModel } = d('modules/customers/customer.model');
const { OrderModel } = d('modules/orders/order.model');
const { InvoiceModel } = d('modules/invoices/invoice.model');
const { PaymentModel } = d('modules/payments/payment.model');
const { ReservationModel } = d('modules/reservations/reservation.model');
const { FeedbackModel } = d('modules/feedback/feedback.model');
const { CounterModel } = d('modules/counters/counter.model');
const { hashPassword } = d('modules/auth/token.service');
const { moneyToWords } = d('utils/numberToWords');

const oid = () => new mongoose.Types.ObjectId();
const round2 = (n) => Math.round(n * 100) / 100;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[randInt(0, arr.length - 1)];
const chance = (p) => Math.random() < p;
const ymd = (dt) =>
  `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
const shortSlug = () =>
  crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 7);

const TAXES = [{ name: 'CA Sales Tax', rate: 8.625, type: 'other', applyOn: 'subtotal' }];

// Replicates backend pricing.computeTotals for the seeded (non-inclusive) config.
function computeTotals(items, discount = 0) {
  let subtotal = 0;
  let modifierTotal = 0;
  for (const it of items) {
    const modSum = it.modifiers.reduce((s, m) => s + (m.priceDelta || 0), 0);
    it.lineTotal = round2((it.basePrice + modSum) * it.qty);
    subtotal += round2(it.basePrice * it.qty);
    modifierTotal += round2(modSum * it.qty);
  }
  subtotal = round2(subtotal);
  modifierTotal = round2(modifierTotal);
  const taxableBase = round2(subtotal + modifierTotal - discount);
  const serviceCharge = 0;
  const taxBase = round2(taxableBase + serviceCharge);
  const taxBreakup = TAXES.map((t) => ({
    name: t.name,
    type: t.type,
    rate: t.rate,
    amount: round2((taxBase * t.rate) / 100),
  }));
  const tax = round2(taxBreakup.reduce((s, t) => s + t.amount, 0));
  const grand = round2(taxBase + tax);
  return { subtotal, modifierTotal, discount, serviceCharge, tax, taxBreakup, roundOff: 0, grand };
}

async function main() {
  await mongoose.connect(uri);
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName) throw new Error('Local MongoDB must be a replica set.');
  console.log(`Connected to ${mongoose.connection.name}`);

  const ownerRole = await RoleModel.findOne({ key: 'owner' });
  if (!ownerRole) throw new Error('Run bootstrap first (npm run dev:local -- --bootstrap).');
  const owner = await UserModel.findOne({ roleId: ownerRole._id });

  // ---- wipe demo collections (keep roles + users, we upsert staff) --------
  await Promise.all([
    CategoryModel.deleteMany({}), ItemModel.deleteMany({}), ModifierGroupModel.deleteMany({}),
    TableModel.deleteMany({}), QrCodeModel.deleteMany({}), InventoryItemModel.deleteMany({}),
    RecipeModel.deleteMany({}), StockMovementModel.deleteMany({}), SupplierModel.deleteMany({}),
    PurchaseOrderModel.deleteMany({}), CustomerModel.deleteMany({}), OrderModel.deleteMany({}),
    InvoiceModel.deleteMany({}), PaymentModel.deleteMany({}), ReservationModel.deleteMany({}),
    FeedbackModel.deleteMany({}),
    CounterModel.deleteMany({ _id: /^(order|window|invoice):/ }),
  ]);
  console.log('Cleared previous demo data');

  // ---- restaurant config ---------------------------------------------------
  const restaurant = await RestaurantModel.findOne({ singleton: 'main' });
  restaurant.brand.name = 'Pinky Promise Café & Restaurant';
  restaurant.brand.contactPhone = '+14155550142';
  restaurant.brand.contactEmail = 'hello@pinkypromise.cafe';
  restaurant.brand.address = '742 Valencia Street, San Francisco, CA 94110';
  restaurant.brand.location = {
    city: 'San Francisco', state: 'CA', country: 'United States',
    postalCode: '94110', lat: 37.7599, lng: -122.4213,
  };
  restaurant.brand.openingHours = Array.from({ length: 7 }, (_, dow) => ({
    dayOfWeek: dow, open: '08:00', close: '22:00', isClosed: false,
  }));
  restaurant.tax.taxes = TAXES;
  restaurant.tax.serviceChargePercent = 0;
  restaurant.tax.roundingRule = 'none';
  restaurant.tax.taxInclusive = false;
  restaurant.currency = 'USD';
  restaurant.timeZone = 'America/Los_Angeles';
  restaurant.paymentMethods = { cash: true, upi: false, card: true, wallet: false, onlinePrepay: false };
  restaurant.operatingModes = { dineIn: true, takeaway: true, onlinePrepay: false };
  restaurant.receipt.headerLines = ['Pinky Promise Café & Restaurant', '742 Valencia St, San Francisco'];
  restaurant.receipt.footerLines = ['Thank you! See you again 💗'];
  await restaurant.save();
  const snap = {
    name: restaurant.brand.name, address: restaurant.brand.address,
    contactPhone: restaurant.brand.contactPhone, contactEmail: restaurant.brand.contactEmail,
    brandColor: restaurant.brand.brandColor, headerLines: restaurant.receipt.headerLines,
    footerLines: restaurant.receipt.footerLines,
  };
  console.log('Configured restaurant (USD, CA sales tax 8.625%, 08:00–22:00 daily)');

  // ---- staff users ---------------------------------------------------------
  const staffDefs = [
    { key: 'manager', email: 'manager@pinky.local', name: 'Morgan Reyes', pw: 'Manager@2026!' },
    { key: 'cashier', email: 'cashier@pinky.local', name: 'Casey Lin', pw: 'Cashier@2026!' },
    { key: 'waiter', email: 'server@pinky.local', name: 'Sam Ortiz', pw: 'Server@2026!' },
    { key: 'kitchen', email: 'kitchen@pinky.local', name: 'Kelly Nowak', pw: 'Kitchen@2026!' },
    { key: 'host', email: 'host@pinky.local', name: 'Harper Diaz', pw: 'HostStaff@2026!' },
  ];
  const staff = {};
  for (const s of staffDefs) {
    const role = await RoleModel.findOne({ key: s.key });
    if (!role) continue;
    let u = await UserModel.findOne({ email: s.email });
    if (!u) {
      u = await UserModel.create({
        email: s.email, name: s.name, passwordHash: await hashPassword(s.pw),
        roleId: role._id, isActive: true,
      });
    }
    staff[s.key] = u;
  }
  const server = staff.waiter || owner;
  const cashier = staff.cashier || owner;
  console.log(`Ensured ${Object.keys(staff).length} staff users`);

  // ---- modifier groups -----------------------------------------------------
  const sizeGroup = await ModifierGroupModel.create({
    name: 'Size', isRequired: true, minSelections: 1, maxSelections: 1,
    modifiers: [
      { name: 'Small', priceDelta: 0, isDefault: true },
      { name: 'Medium', priceDelta: 0.75 },
      { name: 'Large', priceDelta: 1.5 },
    ],
  });
  const milkGroup = await ModifierGroupModel.create({
    name: 'Milk', isRequired: true, minSelections: 1, maxSelections: 1,
    modifiers: [
      { name: 'Whole milk', priceDelta: 0, isDefault: true },
      { name: 'Oat milk', priceDelta: 0.75 },
      { name: 'Almond milk', priceDelta: 0.75 },
      { name: 'Soy milk', priceDelta: 0.5 },
    ],
  });
  const addonGroup = await ModifierGroupModel.create({
    name: 'Add-ons', isRequired: false, minSelections: 0, maxSelections: 3,
    modifiers: [
      { name: 'Extra espresso shot', priceDelta: 1.0 },
      { name: 'Vanilla syrup', priceDelta: 0.6 },
      { name: 'Caramel syrup', priceDelta: 0.6 },
      { name: 'Whipped cream', priceDelta: 0.5 },
    ],
  });

  // ---- categories ----------------------------------------------------------
  const cats = await CategoryModel.create([
    { name: 'Coffee & Espresso', slug: 'coffee-espresso', sortOrder: 0 },
    { name: 'Breakfast', slug: 'breakfast', sortOrder: 1 },
    { name: 'Sandwiches & Toasts', slug: 'sandwiches-toasts', sortOrder: 2 },
    { name: 'Salads & Bowls', slug: 'salads-bowls', sortOrder: 3 },
    { name: 'Pastries & Desserts', slug: 'pastries-desserts', sortOrder: 4 },
    { name: 'Cold Drinks', slug: 'cold-drinks', sortOrder: 5 },
  ]);
  const C = Object.fromEntries(cats.map((c) => [c.slug, c._id]));

  // ---- menu items ----------------------------------------------------------
  const coffeeGroups = [sizeGroup._id, milkGroup._id, addonGroup._id];
  const itemDefs = [
    // Coffee — barista station
    { name: 'Espresso', cat: 'coffee-espresso', price: 3.25, type: 'veg', station: 'barista', groups: [sizeGroup._id, addonGroup._id] },
    { name: 'Cappuccino', cat: 'coffee-espresso', price: 4.75, type: 'veg', station: 'barista', groups: coffeeGroups },
    { name: 'Caffè Latte', cat: 'coffee-espresso', price: 5.25, type: 'veg', station: 'barista', groups: coffeeGroups },
    { name: 'Mocha', cat: 'coffee-espresso', price: 5.75, type: 'veg', station: 'barista', groups: coffeeGroups },
    { name: 'Cold Brew', cat: 'coffee-espresso', price: 4.95, type: 'vegan', station: 'barista', groups: [sizeGroup._id, addonGroup._id] },
    // Breakfast — kitchen
    { name: 'Avocado Toast', cat: 'breakfast', price: 11.5, type: 'vegan', station: 'kitchen', allergens: ['gluten'] },
    { name: 'Breakfast Burrito', cat: 'breakfast', price: 12.75, type: 'egg', station: 'kitchen', allergens: ['egg', 'dairy'] },
    { name: 'Buttermilk Pancakes', cat: 'breakfast', price: 10.95, type: 'veg', station: 'kitchen', allergens: ['gluten', 'dairy', 'egg'], variants: [{ name: 'Short stack', priceDelta: 0 }, { name: 'Tall stack', priceDelta: 3.0 }] },
    { name: 'Veggie Omelette', cat: 'breakfast', price: 12.25, type: 'egg', station: 'kitchen', allergens: ['egg', 'dairy'] },
    // Sandwiches — kitchen
    { name: 'Turkey Club', cat: 'sandwiches-toasts', price: 13.5, type: 'non_veg', station: 'kitchen', allergens: ['gluten'] },
    { name: 'Grilled Cheese', cat: 'sandwiches-toasts', price: 9.75, type: 'veg', station: 'kitchen', allergens: ['gluten', 'dairy'] },
    { name: 'Caprese Panini', cat: 'sandwiches-toasts', price: 12.25, type: 'veg', station: 'kitchen', allergens: ['gluten', 'dairy'] },
    // Salads — kitchen
    { name: 'Cobb Salad', cat: 'salads-bowls', price: 13.95, type: 'non_veg', station: 'kitchen', allergens: ['egg', 'dairy'] },
    { name: 'Quinoa Power Bowl', cat: 'salads-bowls', price: 12.95, type: 'vegan', station: 'kitchen' },
    { name: 'Caesar Salad', cat: 'salads-bowls', price: 11.5, type: 'veg', station: 'kitchen', allergens: ['gluten', 'dairy'] },
    // Pastries — pastry
    { name: 'Butter Croissant', cat: 'pastries-desserts', price: 3.95, type: 'veg', station: 'pastry', allergens: ['gluten', 'dairy'] },
    { name: 'Blueberry Muffin', cat: 'pastries-desserts', price: 3.75, type: 'veg', station: 'pastry', allergens: ['gluten', 'dairy', 'egg'] },
    { name: 'Chocolate Chip Cookie', cat: 'pastries-desserts', price: 2.95, type: 'veg', station: 'pastry', allergens: ['gluten', 'dairy'] },
    { name: 'Cheesecake Slice', cat: 'pastries-desserts', price: 6.5, type: 'veg', station: 'pastry', allergens: ['gluten', 'dairy', 'egg'] },
    // Cold drinks — barista
    { name: 'Iced Tea', cat: 'cold-drinks', price: 3.5, type: 'vegan', station: 'barista' },
    { name: 'Fresh Lemonade', cat: 'cold-drinks', price: 4.25, type: 'vegan', station: 'barista' },
    { name: 'Orange Juice', cat: 'cold-drinks', price: 4.5, type: 'vegan', station: 'barista' },
  ];
  const items = [];
  let sort = 0;
  for (const def of itemDefs) {
    const doc = await ItemModel.create({
      name: def.name,
      slug: def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      categoryId: C[def.cat],
      basePrice: def.price,
      foodType: def.type,
      station: def.station,
      prepTimeMinutes: def.station === 'barista' ? 4 : def.station === 'pastry' ? 2 : 12,
      allergens: def.allergens || [],
      modifierGroupIds: def.groups || [],
      variants: def.variants || [],
      channels: ['dine_in', 'window'],
      sortOrder: sort++,
    });
    items.push({ doc, def });
  }
  const byName = Object.fromEntries(items.map((i) => [i.doc.name, i]));
  const groupById = Object.fromEntries(
    [sizeGroup, milkGroup, addonGroup].map((g) => [String(g._id), g]),
  );
  console.log(`Seeded menu: ${cats.length} categories, ${items.length} items, 3 modifier groups`);

  // ---- tables + QR ---------------------------------------------------------
  const tableDefs = [
    { number: 'P1', zone: 'Patio', capacity: 2 }, { number: 'P2', zone: 'Patio', capacity: 4 },
    { number: 'M1', zone: 'Main', capacity: 4 }, { number: 'M2', zone: 'Main', capacity: 4 },
    { number: 'M3', zone: 'Main', capacity: 6 }, { number: 'M4', zone: 'Main', capacity: 2 },
    { number: 'W1', zone: 'Window', capacity: 2 }, { number: 'W2', zone: 'Window', capacity: 2 },
  ];
  const tables = await TableModel.create(
    tableDefs.map((t, i) => ({ ...t, sortOrder: i, status: 'vacant' })),
  );
  await QrCodeModel.create([
    ...tables.map((t) => ({ type: 'table', slug: shortSlug(), label: `Table ${t.number}`, tableId: t._id, style: 'plain' })),
    { type: 'window', slug: shortSlug(), label: 'Takeaway Window', style: 'branded' },
  ]);
  console.log(`Seeded ${tables.length} tables + ${tables.length + 1} QR codes`);

  // ---- inventory + supplier + PO + recipes ---------------------------------
  const invDefs = [
    { name: 'Espresso Beans', unit: 'kg', stock: 12, low: 3, cost: 18 },
    { name: 'Whole Milk', unit: 'L', stock: 40, low: 10, cost: 1.2 },
    { name: 'Oat Milk', unit: 'L', stock: 18, low: 5, cost: 2.4 },
    { name: 'Sourdough Bread', unit: 'pcs', stock: 60, low: 15, cost: 0.9 },
    { name: 'Avocado', unit: 'pcs', stock: 45, low: 12, cost: 1.1 },
    { name: 'Eggs', unit: 'pcs', stock: 120, low: 30, cost: 0.35 },
    { name: 'Cheddar Cheese', unit: 'kg', stock: 6, low: 2, cost: 9.5 },
    { name: 'Sliced Turkey', unit: 'kg', stock: 5, low: 1.5, cost: 12 },
    { name: 'Mixed Greens', unit: 'kg', stock: 8, low: 2, cost: 6 },
    { name: 'Tomato', unit: 'kg', stock: 10, low: 3, cost: 3.2 },
    { name: 'Flour', unit: 'kg', stock: 25, low: 5, cost: 1.5 },
    { name: 'Butter', unit: 'kg', stock: 7, low: 2, cost: 7 },
    { name: 'Lemons', unit: 'pcs', stock: 50, low: 15, cost: 0.4 },
    { name: 'Quinoa', unit: 'kg', stock: 9, low: 2, cost: 5.5 },
  ];
  const inv = {};
  for (const i of invDefs) {
    const doc = await InventoryItemModel.create({
      name: i.name, unit: i.unit, currentStock: i.stock,
      lowStockThreshold: i.low, costPerUnit: i.cost,
    });
    inv[i.name] = doc;
  }
  const thirtyAgo = new Date(Date.now() - 30 * 864e5);
  await StockMovementModel.collection.insertMany(
    invDefs.map((i) => ({
      _id: oid(), inventoryItemId: inv[i.name]._id, type: 'in', qty: i.stock,
      unit: i.unit, costPerUnit: i.cost, resultingStock: i.stock, actorId: owner._id,
      note: 'Opening stock', createdAt: thirtyAgo, updatedAt: thirtyAgo,
    })),
  );
  const supplier = await SupplierModel.create({
    name: 'Bay Area Provisions Co.', email: 'orders@bayareaprovisions.com',
    phone: '+14155550190', address: 'Oakland, CA', isActive: true,
  });
  await PurchaseOrderModel.create({
    number: 'PO-2026-0001', supplierId: supplier._id, supplierName: supplier.name,
    currency: 'USD', status: 'received', orderedAt: new Date(Date.now() - 5 * 864e5),
    expectedAt: new Date(Date.now() - 2 * 864e5), createdBy: owner._id,
    items: [
      { inventoryItemId: inv['Espresso Beans']._id, name: 'Espresso Beans', unit: 'kg', quantity: 10, received: 10, unitCost: 18 },
      { inventoryItemId: inv['Whole Milk']._id, name: 'Whole Milk', unit: 'L', quantity: 30, received: 30, unitCost: 1.2 },
      { inventoryItemId: inv['Sourdough Bread']._id, name: 'Sourdough Bread', unit: 'pcs', quantity: 50, received: 50, unitCost: 0.9 },
    ],
  });
  await PurchaseOrderModel.create({
    number: 'PO-2026-0002', supplierId: supplier._id, supplierName: supplier.name,
    currency: 'USD', status: 'ordered', orderedAt: new Date(Date.now() - 1 * 864e5),
    expectedAt: new Date(Date.now() + 2 * 864e5), createdBy: owner._id,
    items: [
      { inventoryItemId: inv['Avocado']._id, name: 'Avocado', unit: 'pcs', quantity: 40, received: 0, unitCost: 1.1 },
      { inventoryItemId: inv['Eggs']._id, name: 'Eggs', unit: 'pcs', quantity: 100, received: 0, unitCost: 0.35 },
    ],
  });
  const recipeMap = [
    ['Caffè Latte', [['Espresso Beans', 0.018, 'kg'], ['Whole Milk', 0.2, 'L']]],
    ['Cappuccino', [['Espresso Beans', 0.018, 'kg'], ['Whole Milk', 0.15, 'L']]],
    ['Avocado Toast', [['Sourdough Bread', 2, 'pcs'], ['Avocado', 1, 'pcs']]],
    ['Turkey Club', [['Sourdough Bread', 3, 'pcs'], ['Sliced Turkey', 0.12, 'kg'], ['Cheddar Cheese', 0.03, 'kg']]],
    ['Grilled Cheese', [['Sourdough Bread', 2, 'pcs'], ['Cheddar Cheese', 0.06, 'kg'], ['Butter', 0.01, 'kg']]],
    ['Buttermilk Pancakes', [['Flour', 0.12, 'kg'], ['Eggs', 2, 'pcs'], ['Butter', 0.02, 'kg']]],
    ['Quinoa Power Bowl', [['Quinoa', 0.1, 'kg'], ['Mixed Greens', 0.08, 'kg'], ['Tomato', 0.05, 'kg']]],
    ['Fresh Lemonade', [['Lemons', 2, 'pcs']]],
  ];
  await RecipeModel.create(
    recipeMap
      .filter(([n]) => byName[n])
      .map(([n, ings]) => ({
        itemId: byName[n].doc._id,
        ingredients: ings.map(([inm, qty, unit]) => ({
          inventoryItemId: inv[inm]._id, qty, unit, optional: false,
        })),
      })),
  );
  console.log(`Seeded inventory: ${invDefs.length} items, 1 supplier, 2 POs, ${recipeMap.length} recipes`);

  // ---- customers -----------------------------------------------------------
  const custDefs = [
    ['Olivia Bennett', '+14155551001', 'olivia.bennett@example.com', ['regular']],
    ['Liam Carter', '+14155551002', 'liam.carter@example.com', ['regular']],
    ['Emma Rodriguez', '+14155551003', 'emma.r@example.com', ['vip']],
    ['Noah Patel', '+14155551004', 'noah.patel@example.com', []],
    ['Ava Thompson', '+14155551005', 'ava.t@example.com', ['regular']],
    ['William Nguyen', '+14155551006', 'will.nguyen@example.com', []],
    ['Sophia Martinez', '+14155551007', 'sophia.m@example.com', ['vip']],
    ['James Kim', '+14155551008', 'james.kim@example.com', []],
    ['Isabella Garcia', '+14155551009', 'bella.g@example.com', ['regular']],
    ['Benjamin Lee', '+14155551010', 'ben.lee@example.com', []],
    ['Mia Hernandez', '+14155551011', 'mia.h@example.com', ['regular']],
    ['Lucas Wright', '+14155551012', 'lucas.w@example.com', []],
    ['Charlotte Scott', '+14155551013', 'charlotte.s@example.com', ['vip']],
    ['Henry Adams', '+14155551014', 'henry.adams@example.com', []],
  ];
  const customers = await CustomerModel.create(
    custDefs.map(([name, phone, email, tags]) => ({
      name, phone, email, tags, marketingOptIn: chance(0.6),
    })),
  );
  const custStats = new Map(); // id -> {count, value, last, favs:Map}
  console.log(`Seeded ${customers.length} customers`);

  // ---- helper: build a random order item -----------------------------------
  const menuList = items.map((i) => i.doc);
  function buildItem(itemDoc, def) {
    const modifiers = [];
    let basePrice = itemDoc.basePrice;
    let variantName;
    let variantId;
    if (itemDoc.variants && itemDoc.variants.length && chance(0.5)) {
      const v = pick(itemDoc.variants);
      variantName = v.name;
      variantId = v._id;
      basePrice = round2(basePrice + (v.priceDelta || 0));
    }
    for (const gid of itemDoc.modifierGroupIds || []) {
      const g = groupById[String(gid)];
      if (!g) continue;
      if (g.isRequired) {
        const m = g.modifiers.find((x) => x.isDefault) || pick(g.modifiers);
        if (m.priceDelta) modifiers.push(mkMod(g, m));
        else if (g.name !== 'Milk') modifiers.push(mkMod(g, m)); // record size even at 0
        else modifiers.push(mkMod(g, m));
      } else if (chance(0.4)) {
        const m = pick(g.modifiers);
        modifiers.push(mkMod(g, m));
      }
    }
    const qty = randInt(1, 3);
    const item = {
      _id: oid(), itemId: itemDoc._id, name: itemDoc.name, variantId, variantName,
      qty, basePrice, modifiers, station: def.station, status: 'served', lineTotal: 0,
    };
    const modSum = modifiers.reduce((s, m) => s + m.priceDelta, 0);
    item.lineTotal = round2((basePrice + modSum) * qty);
    return item;
  }
  function mkMod(g, m) {
    return { groupId: g._id, groupName: g.name, modifierId: m._id, modifierName: m.name, priceDelta: m.priceDelta || 0 };
  }

  // ---- settled order history (last 21 days) --------------------------------
  const orderDocs = [];
  const invoiceDocs = [];
  const paymentDocs = [];
  const feedbackDocs = [];
  const daySeq = {};
  const winSeq = {};
  let invSeq = 0;
  const invYear = 2026;

  function orderNumberFor(dt) {
    const key = ymd(dt);
    daySeq[key] = (daySeq[key] || 0) + 1;
    return `${key}-${String(daySeq[key]).padStart(4, '0')}`;
  }

  const openHour = 8;
  const closeHour = 21;
  let settledCount = 0;

  for (let dayBack = 21; dayBack >= 0; dayBack--) {
    const day = new Date();
    day.setDate(day.getDate() - dayBack);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const nOrders = weekend ? randInt(6, 10) : randInt(4, 7);
    for (let k = 0; k < nOrders; k++) {
      const when = new Date(day);
      when.setHours(randInt(openHour, closeHour), randInt(0, 59), randInt(0, 59), 0);
      if (when > new Date()) continue;

      const channel = pick(['dine_in', 'dine_in', 'window', 'assisted']);
      const nLines = randInt(1, 4);
      const orderItems = [];
      for (let l = 0; l < nLines; l++) {
        const m = pick(items);
        orderItems.push(buildItem(m.doc, m.def));
      }
      const totals = computeTotals(orderItems);
      const oId = oid();
      const orderNumber = orderNumberFor(when);

      // customer link (~65%)
      let customer = null;
      if (chance(0.65)) customer = pick(customers);

      const tableId = channel === 'dine_in' ? pick(tables)._id : undefined;
      let windowToken;
      if (channel === 'window') {
        const wk = ymd(when);
        winSeq[wk] = (winSeq[wk] || 0) + 1;
        windowToken = `T-${String(winSeq[wk]).padStart(3, '0')}`;
      }

      const tl = (status, offsetMin) => ({
        _id: oid(), status, at: new Date(when.getTime() + offsetMin * 60000),
        byName: status === 'placed' ? (customer ? customer.name : 'Guest') : server.name,
      });

      orderDocs.push({
        _id: oId, orderNumber, currency: 'USD', financialVersion: 1, channel,
        status: 'settled', paymentStatus: 'paid',
        tableId, windowToken,
        guestName: customer ? customer.name : channel === 'window' ? 'Walk-in' : undefined,
        guestPhone: customer ? customer.phone : undefined,
        customerId: customer ? customer._id : undefined,
        waiterId: channel === 'dine_in' ? server._id : undefined,
        acceptedById: server._id,
        items: orderItems,
        totals,
        estimatedPrepMinutes: 12,
        inventoryDeductedAt: when,
        customerCreditedAt: when,
        pickupAt: channel === 'window' ? new Date(when.getTime() + 15 * 60000) : undefined,
        pickedUpAt: channel === 'window' ? new Date(when.getTime() + 18 * 60000) : undefined,
        timeline: [tl('placed', 0), tl('accepted', 1), tl('preparing', 2), tl('ready', 12), tl('served', 15), tl('settled', 25)],
        guestRequests: [],
        createdAt: when, updatedAt: new Date(when.getTime() + 25 * 60000),
      });

      // invoice
      invSeq += 1;
      const invoiceNumber = `INV/${invYear}/${String(invSeq).padStart(6, '0')}`;
      const tip = chance(0.45) ? round2(totals.grand * pick([0.1, 0.15, 0.18, 0.2])) : 0;
      const issue = new Date(when.getTime() + 20 * 60000);
      invoiceDocs.push({
        _id: oid(), invoiceNumber, currency: 'USD', timeZone: 'America/Los_Angeles',
        orderId: oId, orderNumberSnapshot: orderNumber,
        issueDate: issue, billedAt: issue,
        cashierId: cashier._id, cashierName: cashier.name,
        customerName: customer ? customer.name : undefined,
        customerPhone: customer ? customer.phone : undefined,
        tableNumber: tableId ? tables.find((t) => String(t._id) === String(tableId)).number : undefined,
        channel,
        restaurantSnapshot: snap,
        lineItems: orderItems.map((it) => {
          const modSum = it.modifiers.reduce((s, m) => s + m.priceDelta, 0);
          return {
            orderItemId: it._id, name: it.name, variantName: it.variantName, qty: it.qty,
            unitPrice: it.basePrice, modifierTotal: round2(modSum * it.qty),
            lineSubtotal: round2(it.basePrice * it.qty), taxBreakup: [], lineTotal: it.lineTotal,
          };
        }),
        subtotal: totals.subtotal, modifierTotal: totals.modifierTotal, discount: 0,
        serviceCharge: 0, tip, taxBreakup: totals.taxBreakup, tax: totals.tax,
        roundOff: 0, grand: totals.grand, amountInWords: moneyToWords(totals.grand, 'USD'),
        amountPaid: totals.grand, amountRefunded: 0, amountDue: 0, paymentStatus: 'paid',
        splitMode: 'none', splits: [], status: 'final', loyaltyPointsEarned: Math.round(totals.grand),
        createdAt: issue, updatedAt: issue,
      });

      // payment
      const mode = pick(['card', 'card', 'cash']);
      const pay = {
        _id: oid(), invoiceId: invoiceDocs[invoiceDocs.length - 1]._id, orderId: oId,
        mode, amount: totals.grand, status: 'success', receivedAt: issue,
        cashierId: cashier._id, tip, refundedAmount: 0,
        createdAt: issue, updatedAt: issue,
      };
      if (mode === 'cash') {
        const tendered = Math.ceil((totals.grand + tip) / 5) * 5;
        pay.cashTendered = tendered;
        pay.changeReturned = round2(tendered - totals.grand - tip);
      } else {
        pay.provider = undefined;
        pay.txnRef = `EXT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      }
      paymentDocs.push(pay);

      // customer rollup accumulation
      if (customer) {
        const s = custStats.get(String(customer._id)) || { count: 0, value: 0, last: when, favs: new Map() };
        s.count += 1;
        s.value = round2(s.value + totals.grand);
        if (when > s.last) s.last = when;
        for (const it of orderItems) {
          const f = s.favs.get(it.name) || { itemId: it.itemId, name: it.name, count: 0, lastAt: when };
          f.count += it.qty;
          if (when > f.lastAt) f.lastAt = when;
          s.favs.set(it.name, f);
        }
        custStats.set(String(customer._id), s);
      }

      // feedback (~35% of settled)
      if (chance(0.35)) {
        const rating = pick([5, 5, 4, 4, 4, 3, 5, 2]);
        const sentiment = rating >= 4 ? 'positive' : rating === 3 ? 'neutral' : 'negative';
        feedbackDocs.push({
          _id: oid(), orderId: oId, orderNumber, customerId: customer ? customer._id : undefined,
          customerPhone: customer ? customer.phone : undefined,
          customerName: customer ? customer.name : undefined,
          rating,
          text: pick([
            'Loved the latte, great foam!', 'Quick service and friendly staff.',
            'Avocado toast was delicious.', 'A bit slow at peak but food was great.',
            'Cozy spot, will come back.', 'Order was slightly off but they fixed it fast.',
            undefined,
          ]),
          tagChips: [pick(['food', 'service', 'speed', 'ambience', 'staff', 'taste'])],
          sentiment, acknowledged: chance(0.5), channel,
          createdAt: issue, updatedAt: issue,
        });
      }
      settledCount += 1;
    }
  }

  await OrderModel.collection.insertMany(orderDocs);
  await InvoiceModel.collection.insertMany(invoiceDocs);
  await PaymentModel.collection.insertMany(paymentDocs);
  if (feedbackDocs.length) await FeedbackModel.collection.insertMany(feedbackDocs);
  console.log(`Seeded ${settledCount} settled orders + invoices + payments, ${feedbackDocs.length} feedback`);

  // apply customer rollups
  for (const [id, s] of custStats) {
    const favs = [...s.favs.values()].sort((a, b) => b.count - a.count).slice(0, 5);
    await CustomerModel.updateOne(
      { _id: id },
      {
        $set: {
          visitCount: s.count, lifetimeValue: s.value,
          averageBill: round2(s.value / s.count), lastVisitAt: s.last, favoriteItems: favs,
        },
      },
    );
  }

  // ---- live / active orders (today, on the floor) --------------------------
  const activeDocs = [];
  const activeConfigs = [
    { channel: 'dine_in', status: 'preparing', itemStatus: 'preparing', tableStatus: 'ordered', ago: 6 },
    { channel: 'dine_in', status: 'preparing', itemStatus: 'accepted', tableStatus: 'ordered', ago: 3 },
    { channel: 'dine_in', status: 'ready', itemStatus: 'ready', tableStatus: 'ordered', ago: 14 },
    { channel: 'dine_in', status: 'served', itemStatus: 'served', tableStatus: 'awaiting_bill', ago: 25 },
    { channel: 'window', status: 'preparing', itemStatus: 'preparing', ago: 5 },
    { channel: 'window', status: 'ready', itemStatus: 'ready', ago: 11 },
    { channel: 'window', status: 'placed', itemStatus: 'pending', ago: 1 },
  ];
  const freeTables = [...tables];
  let wSeqToday = winSeq[ymd(new Date())] || 0;
  for (const cfg of activeConfigs) {
    const when = new Date(Date.now() - cfg.ago * 60000);
    const nLines = randInt(1, 3);
    const orderItems = [];
    for (let l = 0; l < nLines; l++) {
      const m = pick(items);
      const it = buildItem(m.doc, m.def);
      it.status = cfg.itemStatus;
      orderItems.push(it);
    }
    const totals = computeTotals(orderItems);
    const oId = oid();
    let tableId;
    if (cfg.channel === 'dine_in' && freeTables.length) {
      const t = freeTables.splice(randInt(0, freeTables.length - 1), 1)[0];
      tableId = t._id;
      await TableModel.updateOne({ _id: t._id }, { $set: { status: cfg.tableStatus } });
    }
    let windowToken;
    if (cfg.channel === 'window') {
      wSeqToday += 1;
      windowToken = `T-${String(wSeqToday).padStart(3, '0')}`;
    }
    const customer = chance(0.5) ? pick(customers) : null;
    activeDocs.push({
      _id: oId, orderNumber: orderNumberFor(when), currency: 'USD', financialVersion: 1,
      channel: cfg.channel, status: cfg.status, paymentStatus: 'unpaid',
      tableId, windowToken,
      guestName: customer ? customer.name : cfg.channel === 'window' ? 'Walk-in' : undefined,
      guestPhone: customer ? customer.phone : undefined,
      customerId: customer ? customer._id : undefined,
      waiterId: cfg.channel === 'dine_in' ? server._id : undefined,
      acceptedById: cfg.status === 'placed' ? undefined : server._id,
      items: orderItems, totals, estimatedPrepMinutes: 12,
      pickupAt: cfg.channel === 'window' ? new Date(when.getTime() + 15 * 60000) : undefined,
      timeline: [{ _id: oid(), status: 'placed', at: when, byName: 'Guest' }],
      guestRequests: [], createdAt: when, updatedAt: when,
    });
  }
  await OrderModel.collection.insertMany(activeDocs);
  if (winSeq[ymd(new Date())] === undefined) winSeq[ymd(new Date())] = wSeqToday;
  else winSeq[ymd(new Date())] = wSeqToday;
  console.log(`Seeded ${activeDocs.length} active (live) orders on the floor`);

  // ---- reservations --------------------------------------------------------
  const resDocs = [];
  const resNames = ['Grace Miller', 'Ethan Brooks', 'Zoe Campbell', 'Daniel Foster', 'Lily Turner', 'Owen Bailey', 'Chloe Rivera', 'Nathan Cooper'];
  // upcoming
  for (let i = 0; i < 5; i++) {
    const when = new Date();
    when.setDate(when.getDate() + randInt(0, 6));
    when.setHours(randInt(11, 20), pick([0, 15, 30, 45]), 0, 0);
    resDocs.push({
      _id: oid(), restaurantId: restaurant._id, kind: 'reservation',
      guestName: pick(resNames), guestPhone: `+1415555${randInt(2000, 2999)}`,
      partySize: randInt(2, 6), reservedAt: when, durationMinutes: 90,
      status: pick(['pending', 'confirmed', 'confirmed']),
      tableId: chance(0.5) ? pick(tables)._id : undefined,
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
  // past
  for (let i = 0; i < 4; i++) {
    const when = new Date();
    when.setDate(when.getDate() - randInt(1, 10));
    when.setHours(randInt(11, 20), 0, 0, 0);
    resDocs.push({
      _id: oid(), restaurantId: restaurant._id, kind: 'reservation',
      guestName: pick(resNames), guestPhone: `+1415555${randInt(2000, 2999)}`,
      partySize: randInt(2, 5), reservedAt: when, durationMinutes: 90,
      status: pick(['completed', 'completed', 'no_show']),
      createdAt: when, updatedAt: when,
    });
  }
  // one waitlist entry for today
  resDocs.push({
    _id: oid(), restaurantId: restaurant._id, kind: 'waitlist',
    guestName: pick(resNames), guestPhone: `+1415555${randInt(2000, 2999)}`,
    partySize: 2, reservedAt: new Date(), durationMinutes: 60, status: 'pending',
    createdAt: new Date(), updatedAt: new Date(),
  });
  await ReservationModel.collection.insertMany(resDocs);
  console.log(`Seeded ${resDocs.length} reservations`);

  // ---- counters (so real future numbers continue cleanly) ------------------
  const counterOps = [];
  for (const [k, v] of Object.entries(daySeq)) counterOps.push({ _id: `order:${k}`, seq: v });
  for (const [k, v] of Object.entries(winSeq)) counterOps.push({ _id: `window:${k}`, seq: v });
  counterOps.push({ _id: `invoice:calendar:${invYear}`, seq: invSeq });
  for (const c of counterOps) {
    await CounterModel.updateOne({ _id: c._id }, { $set: { seq: c.seq } }, { upsert: true });
  }

  console.log('\n✅ Rich demo data seeded.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
