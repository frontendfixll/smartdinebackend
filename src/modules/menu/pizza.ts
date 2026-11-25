export const pizzaArtwork = [
  "mozzarella",
  "pepperoni",
  "mushroom",
  "olive",
  "basil",
  "pepper",
  "onion",
  "tomato",
  // burger
  "cheddar",
  "lettuce",
  "bacon",
  "pickle",
  "sauce",
  "jalapeno",
  // taco
  "salsa",
  "avocado",
  "corn",
  "sour-cream",
] as const;
export type PizzaArtwork = (typeof pizzaArtwork)[number];
export type BuilderKind = 'pizza' | 'burger' | 'taco';
export interface PizzaBuilder {
  enabled: true;
  kind?: BuilderKind;
  baseImageUrl?: string;
}
