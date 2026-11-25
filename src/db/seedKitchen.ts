import { Types } from "mongoose";
import { getOrCreateRestaurant } from "@modules/restaurant/restaurant.service";
import { CategoryModel } from "@modules/menu/category.model";
import { ItemModel } from "@modules/menu/item.model";
import { ModifierGroupModel } from "@modules/menu/modifierGroup.model";
import { connectDatabase, disconnectDatabase } from "./connect";

async function seedBurger(currency: string) {
  const itemId = new Types.ObjectId("63504a5a5000000000000010");
  if (await ItemModel.exists({ _id: itemId })) return;
  const prices = currency === "INR" ? [200, 280] : [10, 14];
  if (currency !== "INR" && currency !== "USD")
    throw Error("Create the burger in the menu editor with prices in " + currency);
  const category = await CategoryModel.findOneAndUpdate(
    { slug: "burgers" },
    { $setOnInsert: { name: "Burgers", slug: "burgers", sortOrder: 6 } },
    { upsert: true, new: true },
  );
  const group = await ModifierGroupModel.findOneAndUpdate(
    { _id: "63504a5a5000000000000011" },
    {
      $setOnInsert: {
        name: "Burger extras",
        isRequired: false,
        minSelections: 0,
        maxSelections: 3,
        modifiers: [
          { _id: new Types.ObjectId(), name: "Cheddar",       pizzaArt: "cheddar", priceDelta: currency === "INR" ? 25 : 1,   isDefault: true,  is86: false },
          { _id: new Types.ObjectId(), name: "Lettuce",       pizzaArt: "lettuce", priceDelta: 0,                              isDefault: true,  is86: false },
          { _id: new Types.ObjectId(), name: "Sliced tomato", pizzaArt: "tomato",  priceDelta: 0,                              isDefault: false, is86: false },
        ],
      },
    },
    { upsert: true, new: true },
  );
  await ItemModel.updateOne(
    { _id: itemId },
    {
      $setOnInsert: {
        name: "Build-your-own Burger",
        slug: "build-your-own-burger",
        categoryId: category._id,
        description: "Toasted brioche bun, smash patty, your choice of toppings.",
        foodType: "non_veg",
        allergens: ["wheat", "milk", "soy"],
        basePrice: prices[0],
        station: "grill",
        variants: ["Single", "Double"].map((name, i) => ({
          name,
          absolutePrice: prices[i],
        })),
        modifierGroupIds: [group._id],
        pizzaBuilder: { enabled: true, kind: "burger" },
      },
    },
    { upsert: true },
  );
}

async function seedTaco(currency: string) {
  const itemId = new Types.ObjectId("63504a5a5000000000000020");
  if (await ItemModel.exists({ _id: itemId })) return;
  const prices = currency === "INR" ? [120, 220] : [6, 11];
  if (currency !== "INR" && currency !== "USD")
    throw Error("Create the taco in the menu editor with prices in " + currency);
  const category = await CategoryModel.findOneAndUpdate(
    { slug: "tacos" },
    { $setOnInsert: { name: "Tacos", slug: "tacos", sortOrder: 7 } },
    { upsert: true, new: true },
  );
  const group = await ModifierGroupModel.findOneAndUpdate(
    { _id: "63504a5a5000000000000021" },
    {
      $setOnInsert: {
        name: "Taco toppings",
        isRequired: false,
        minSelections: 0,
        maxSelections: 3,
        modifiers: [
          { _id: new Types.ObjectId(), name: "Pico de gallo",   pizzaArt: "salsa",   priceDelta: 0,                              isDefault: true,  is86: false },
          { _id: new Types.ObjectId(), name: "Avocado",         pizzaArt: "avocado", priceDelta: currency === "INR" ? 30 : 1.5,  isDefault: false, is86: false },
          { _id: new Types.ObjectId(), name: "Grated cheddar",  pizzaArt: "cheddar", priceDelta: currency === "INR" ? 20 : 1,    isDefault: true,  is86: false },
        ],
      },
    },
    { upsert: true, new: true },
  );
  await ItemModel.updateOne(
    { _id: itemId },
    {
      $setOnInsert: {
        name: "Build-your-own Taco",
        slug: "build-your-own-taco",
        categoryId: category._id,
        description: "Warm flour tortilla, seasoned black beans, your choice of toppings.",
        foodType: "veg",
        allergens: ["wheat", "milk"],
        basePrice: prices[0],
        station: "grill",
        variants: ["One", "Two"].map((name, i) => ({
          name,
          absolutePrice: prices[i],
        })),
        modifierGroupIds: [group._id],
        pizzaBuilder: { enabled: true, kind: "taco" },
      },
    },
    { upsert: true },
  );
}

async function seedKitchen() {
  const { currency } = await getOrCreateRestaurant();
  await seedBurger(currency);
  await seedTaco(currency);
  console.log("Kitchen items seeded.");
}

if (require.main === module) {
  connectDatabase()
    .then(seedKitchen)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(disconnectDatabase);
}
