// Run after building, with PIZZA_TEST_MONGO pointing to a local test replica set.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const uri = process.env.PIZZA_TEST_MONGO;
if (!uri || !/^mongodb:\/\/(localhost|127\.0\.0\.1):\d+\//.test(uri))
  throw Error("Local test replica set required");
Object.assign(process.env, {
  NODE_ENV: "test",
  MONGODB_URI: uri,
  JWT_ACCESS_SECRET: "local-pizza-test-access",
  JWT_GUEST_SECRET: "local-pizza-test-guest",
  JWT_REFRESH_SECRET: "local-pizza-test-refresh",
});
const mongoose = require("mongoose");
const { seedPizza } = require("../dist/db/seedPizza");
const { getPublicMenu } = require("../dist/modules/menu/publicMenu.service");
const {
  updateModifierGroup,
} = require("../dist/modules/menu/modifierGroup.service");
const {
  ModifierGroupModel,
} = require("../dist/modules/menu/modifierGroup.model");
const { ItemModel } = require("../dist/modules/menu/item.model");
const {
  getOrCreateRestaurant,
} = require("../dist/modules/restaurant/restaurant.service");
const {
  placeWindowOrder,
  placeDineInOrder,
  quoteGuestItems,
} = require("../dist/modules/orders/order.service");
const { getQueue } = require("../dist/modules/kds/kds.service");
const { TableModel } = require("../dist/modules/tables/table.model");
const { QrCodeModel } = require("../dist/modules/qr/qrCode.model");
async function run() {
  await mongoose.connect(uri, {
    dbName: "test_pizza_" + randomUUID().replaceAll("-", ""),
  });
  try {
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    const restaurant = await getOrCreateRestaurant();
    restaurant.currency = "INR";
    restaurant.tax.taxes = [
      { name: "Test tax", type: "other", rate: 0, applyOn: "subtotal" },
    ];
    await restaurant.save();
    await seedPizza();
    await seedPizza();
    assert.equal(await ItemModel.countDocuments(), 1);
    const menu = await getPublicMenu({ channel: "window" });
    const pizza = menu.categories[0].items[0],
      group = pizza.modifierGroups[0];
    assert.equal(pizza.pizzaBuilder.enabled, true);
    const cheese = group.modifiers.find((m) => m.isDefault),
      mushroom = group.modifiers.find((m) => m.pizzaArt === "mushroom");
    const line = (size, mods) => ({
      itemId: pizza.id,
      variantId: size.id,
      qty: 1,
      modifiers: mods.map((m) => ({ groupId: group.id, modifierId: m.id })),
    });
    const items = [
      line(pizza.variants[2], [cheese, mushroom]),
      line(pizza.variants[0], [cheese]),
    ];
    const quote = await quoteGuestItems(items);
    assert.equal(quote.totals.modifierTotal, 25);
    assert.equal(quote.totals.subtotal, 650);
    const args = { items, maxTotal: quote.totals.grand };
    const pickup = await placeWindowOrder(args, "9111111111");
    const table = await TableModel.create({ number: "P1", capacity: 2 });
    await QrCodeModel.create({
      slug: "pizza-test",
      type: "table",
      tableId: table._id,
      label: "Table P1",
      isActive: true,
    });
    const dine = await placeDineInOrder({ ...args, qrSlug: "pizza-test" });
    assert.equal(String(dine.tableId), String(table._id));
    const tickets = await getQueue("pizza");
    for (const order of [pickup, dine]) {
      const ticket = tickets.find((o) => o.id === String(order._id));
      assert.deepEqual(
        ticket.items.map((i) => [i.variantName, i.modifiers]),
        [
          ["Large", ["Mozzarella", "Mushroom"]],
          ["Small", ["Mozzarella"]],
        ],
      );
    }
    const doc = await ModifierGroupModel.findById(group.id).lean();
    const edits = doc.modifiers.map((m) => ({
      ...m,
      _id: String(m._id),
      ...(String(m._id) === mushroom.id
        ? { name: "Roasted mushroom", is86: true, priceDelta: 35 }
        : {}),
    }));
    await updateModifierGroup(group.id, { modifiers: edits }, {});
    const visible = async () =>
      (await getPublicMenu({ channel: "dine_in" })).categories[0].items[0];
    assert.ok(
      !(await visible()).modifierGroups[0].modifiers.some(
        (m) => m.id === mushroom.id,
      ),
    );
    await assert.rejects(quoteGuestItems(items), /unavailable/);
    edits.find((m) => m._id === mushroom.id).is86 = false;
    await updateModifierGroup(group.id, { modifiers: edits }, {});
    const restored = (await visible()).modifierGroups[0].modifiers.find(
      (m) => m.id === mushroom.id,
    );
    assert.equal(restored.name, "Roasted mushroom");
    assert.equal(restored.pizzaArt, "mushroom");
    assert.equal((await quoteGuestItems(items)).totals.modifierTotal, 35);
    await assert.rejects(
      quoteGuestItems([{ ...items[0], variantId: undefined }]),
      /size/,
    );
    console.log(
      "PASS pilot reseed, guest menu and default art, pricing, pickup and QR tickets, renaming, sold-out and restored toppings.",
    );
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
