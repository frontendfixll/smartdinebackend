import { Types } from "mongoose";
import { getOrCreateRestaurant } from "@modules/restaurant/restaurant.service";
import { CategoryModel } from "@modules/menu/category.model";
import { ItemModel } from "@modules/menu/item.model";
import { ModifierGroupModel } from "@modules/menu/modifierGroup.model";
import type { PizzaArtwork } from "@modules/menu/pizza";
import { connectDatabase, disconnectDatabase } from "./connect";

const options: [string, PizzaArtwork, number][] = [
  ["Mozzarella", "mozzarella", 0],
  ["Mushroom", "mushroom", 25],
  ["Black olives", "olive", 20],
  ["Fresh basil", "basil", 0],
  ["Sweet pepper", "pepper", 15],
  ["Red onion", "onion", 10],
  ["Tomato", "tomato", 15],
];

// Only insert the sample recipe. Re-running this command preserves the restaurant's edits.
export async function seedPizza() {
  const itemId = new Types.ObjectId("63504a5a5000000000000001");
  if (await ItemModel.exists({ _id: itemId })) return;
  const { currency } = await getOrCreateRestaurant();
  const sizes = currency === "INR" ? [240, 320, 410] : [10, 13, 16];
  if (currency !== "INR" && currency !== "USD")
    throw Error(
      "Create this pizza in the menu editor with prices in " + currency,
    );
  const dollars = [0, 1.25, 1, 0, 0.75, 0.5, 0.75];
  const category = await CategoryModel.findOneAndUpdate(
    { slug: "pizza" },
    {
      $setOnInsert: { name: "Pizza", slug: "pizza", sortOrder: 5 },
    },
    { upsert: true, new: true },
  );
  const group = await ModifierGroupModel.findOneAndUpdate(
    { _id: "63504a5a5000000000000002" },
    {
      $setOnInsert: {
        name: "Pizza toppings",
        isRequired: false,
        minSelections: 0,
        maxSelections: 7,
        modifiers: options.map(([name, pizzaArt, priceDelta], index) => ({
          _id: new Types.ObjectId(),
          name,
          pizzaArt,
          priceDelta: currency === "INR" ? priceDelta : dollars[index],
          isDefault: pizzaArt === "mozzarella",
          is86: false,
        })),
      },
    },
    { upsert: true, new: true },
  );
  await ItemModel.updateOne(
    { _id: itemId },
    {
      $setOnInsert: {
        name: "Garden pizza",
        slug: "garden-pizza-builder",
        categoryId: category._id,
        description:
          "Tomato sauce on a blistered crust, finished with your choice of toppings.",
        foodType: "veg",
        allergens: ["wheat", "milk"],
        basePrice: sizes[0],
        station: "pizza",
        variants: ["Small", "Medium", "Large"].map((name, i) => ({
          name,
          absolutePrice: sizes[i],
        })),
        modifierGroupIds: [group._id],
        pizzaBuilder: { enabled: true },
      },
    },
    { upsert: true },
  );
}

if (require.main === module) {
  connectDatabase()
    .then(seedPizza)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(disconnectDatabase);
}
