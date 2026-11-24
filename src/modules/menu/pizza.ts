export const pizzaArtwork = [
  "mozzarella",
  "pepperoni",
  "mushroom",
  "olive",
  "basil",
  "pepper",
  "onion",
  "tomato",
] as const;
export type PizzaArtwork = (typeof pizzaArtwork)[number];
export interface PizzaBuilder {
  enabled: true;
  baseImageUrl?: string;
}
