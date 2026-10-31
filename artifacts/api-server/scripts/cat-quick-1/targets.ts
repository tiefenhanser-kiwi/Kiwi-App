// CAT-QUICK-1 (D-WS9-365) — the concepts to build, after de-duplication (dedup.md).
//
// Each row is a CONCEPT from chat-Claude's research (kiwi_quick_meals_concepts.md, row `n`):
// a dish idea, its protein and cuisine, the store product it already uses. Facts only (D-WS9-365
// IP rule): Kiwi writes its own recipe from the name through the store prompts. `shortcut` is
// ONLY a product the concept itself names (rotisserie chicken, instant ramen, frozen dumplings…);
// it rides the shortcut line (Shortcut mode: a plain ingredient, no from-scratch alternative).
// `tags` are the concept's pantry / fridge-rescue tags (D, for NOW-1). `replacesKm30` is the
// km30 meal this concept already exists as at >35 minutes (Hans's rule: build; if the new one
// stamps ≤30, archive the old one in the same commit).

export interface QuickTarget {
  n: number;
  title: string;
  cuisine: string;
  protein: string;
  shortcut?: string;
  tags?: ("pantry" | "fridge-rescue")[];
  replacesKm30?: string;
}

export const KEY_PREFIX = "kq1-";
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const keyFor = (t: QuickTarget) => `${KEY_PREFIX}${String(t.n).padStart(3, "0")}-${slug(t.title)}`.slice(0, 120);

export const TARGETS: QuickTarget[] = [
  { n: 1, title: "Marry Me Chicken (Seared Chicken Breast in Sun-Dried Tomato Parmesan Cream)", cuisine: "Italian-American", protein: "chicken" },
  { n: 2, title: "Cowboy Butter Chicken (Seared Chicken with Garlic-Dijon-Lemon Herb Butter)", cuisine: "American", protein: "chicken" },
  { n: 7, title: "Chicken Paillard with Lemon-Herb Butter", cuisine: "French", protein: "chicken", replacesKm30: "69c7fb8e" },
  { n: 10, title: "Lemon Chicken and Asparagus Stir-Fry", cuisine: "Asian-American", protein: "chicken" },
  { n: 12, title: "Chicken Caesar Smash Tacos", cuisine: "American", protein: "chicken", shortcut: "bottled Caesar dressing" },
  { n: 13, title: "Chicken Gyro Smash Tacos with Tzatziki", cuisine: "Greek-American", protein: "chicken", shortcut: "store-bought tzatziki" },
  { n: 14, title: "Sheet-Pan Crispy Ramen with Chicken Thighs and Broccoli", cuisine: "Asian-American", protein: "chicken", shortcut: "instant ramen noodle bricks (seasoning packets not used)" },
  { n: 16, title: "Skillet Chicken Thigh Tacos with Green Cilantro-Jalapeño Sauce", cuisine: "Mexican-American", protein: "chicken" },
  { n: 17, title: "Thai Peanut Chicken Bowls with Rice and Shredded Cabbage", cuisine: "Thai-American", protein: "chicken" },
  { n: 18, title: "Chicken Parm Meatball Skillet", cuisine: "Italian-American", protein: "chicken" },
  { n: 19, title: "Butter Chicken Meatballs with Naan", cuisine: "Indian", protein: "chicken", shortcut: "store-bought naan" },
  { n: 20, title: "Creamy Dijon Chicken", cuisine: "French-American", protein: "chicken" },
  { n: 22, title: "Creamy Thai Turmeric Chicken and Rice Noodles", cuisine: "Thai", protein: "chicken" },
  { n: 23, title: "Southwest Chicken and Rice Skillet with Black Beans, Corn and Cheddar", cuisine: "Tex-Mex", protein: "chicken", shortcut: "jarred salsa" },
  { n: 24, title: "Grilled Boneless Chicken Thighs with Charred Scallion Sauce", cuisine: "Asian-American", protein: "chicken" },
  { n: 25, title: "Quick Tandoori-Style Yogurt Chicken", cuisine: "Indian", protein: "chicken" },
  { n: 28, title: "Ground Beef and Cabbage Stir-Fry", cuisine: "Asian-American", protein: "beef" },
  { n: 31, title: "Palomilla Steak with Onions, Black Beans and Rice", cuisine: "Cuban", protein: "beef" },
  { n: 32, title: "Kenyan Beef Wet Fry", cuisine: "Kenyan", protein: "beef" },
  { n: 34, title: "Mongolian Beef Ramen", cuisine: "Chinese-American", protein: "beef", shortcut: "instant ramen noodle bricks (seasoning packets not used)" },
  { n: 35, title: "Sesame Pork Milanese", cuisine: "Italian-Japanese", protein: "pork" },
  { n: 36, title: "Pork Chops Pizzaiola", cuisine: "Italian-American", protein: "pork" },
  { n: 37, title: "Pork and Green Onion Stir-Fry", cuisine: "Chinese", protein: "pork" },
  { n: 38, title: "Spicy Gochujang Ground Pork over Rice", cuisine: "Korean", protein: "pork" },
  { n: 39, title: "Moo Shu Pork Wraps", cuisine: "Chinese-American", protein: "pork", shortcut: "bagged coleslaw mix; flour tortillas" },
  { n: 42, title: "Chili-Lime Air Fryer Salmon", cuisine: "Mexican-American", protein: "salmon" },
  { n: 43, title: "Hot Honey Salmon Bites Bowl", cuisine: "American", protein: "salmon", shortcut: "bottled hot honey" },
  { n: 44, title: "Leftover Salmon Rice Bowl with Kewpie Mayo and Seaweed", cuisine: "Japanese-American", protein: "salmon", shortcut: "leftover cooked salmon; cooked rice (leftover or a microwavable pouch); roasted seaweed snacks", tags: ["fridge-rescue"] },
  { n: 45, title: "Salmon Piccata", cuisine: "Italian-American", protein: "salmon" },
  { n: 48, title: "White Fish Taco Foil Packets with Lime Cabbage Slaw", cuisine: "Mexican-American", protein: "fish" },
  { n: 50, title: "One-Pan Chimichurri Shrimp", cuisine: "Argentinian", protein: "shrimp" },
  { n: 51, title: "Camarones a la Diabla", cuisine: "Mexican", protein: "shrimp" },
  { n: 53, title: "Skillet Shrimp with Orzo, Feta and Asparagus", cuisine: "Greek-American", protein: "shrimp" },
  { n: 54, title: "Thai Stir-Fried Shrimp with Chile Jam and Jasmine Rice", cuisine: "Thai", protein: "shrimp", shortcut: "jarred Thai chile jam (nam prik pao)" },
  { n: 56, title: "Baked Feta Pasta with Cherry Tomatoes", cuisine: "Mediterranean", protein: "cheese" },
  { n: 57, title: "Marry Me Chickpeas", cuisine: "Italian-American", protein: "legume" },
  { n: 59, title: "Chili Crunch Tofu with Rice", cuisine: "Asian-American", protein: "tofu", shortcut: "jarred chili crunch" },
  { n: 60, title: "Bang Bang Tofu with Rice", cuisine: "Asian-American", protein: "tofu", shortcut: "bottled sweet chili sauce" },
  { n: 61, title: "Spicy Peanut Tofu Bowls", cuisine: "Thai-American", protein: "tofu" },
  { n: 62, title: "Creamy Cottage Cheese Pasta with Spinach", cuisine: "Italian-American", protein: "cheese" },
  { n: 63, title: "Cacio e Pepe White Beans", cuisine: "Italian-American", protein: "legume", tags: ["pantry"] },
  { n: 64, title: "Pizza Beans Skillet", cuisine: "Italian-American", protein: "legume", shortcut: "jarred marinara", tags: ["pantry"] },
  { n: 65, title: "Cheesy Broccoli-Cheddar Chickpea Skillet with Cracker Crumbs", cuisine: "American", protein: "legume" },
  { n: 66, title: "Eggs in Purgatory with Crusty Bread", cuisine: "Italian", protein: "egg", tags: ["pantry"] },
  { n: 67, title: "Dense Bean Salad with Cucumber, Red Onion, Herbs and Feta", cuisine: "Mediterranean", protein: "legume" },
  { n: 68, title: "Garlicky Kale Salad with Crispy Spiced Chickpeas and Tahini", cuisine: "Mediterranean", protein: "legume" },
  { n: 69, title: "Portobello Mushroom Stir-Fry with Rice", cuisine: "Asian", protein: "portobello" },
  { n: 70, title: "Lentil Sloppy Joes", cuisine: "American", protein: "legume" },
  { n: 71, title: "Noodle-Free Vegetable Pad Thai with Almond Butter Sauce", cuisine: "Thai", protein: "nut" },
  { n: 72, title: "Poblano and Portobello Fajitas", cuisine: "Tex-Mex", protein: "portobello" },
  { n: 73, title: "Vegan Mushroom Stroganoff", cuisine: "Eastern European", protein: "mushroom" },
  { n: 74, title: "Creamy Mushroom and Asparagus Pasta (Dairy-Free, Gluten-Free)", cuisine: "Italian-American", protein: "mushroom" },
  { n: 75, title: "Zucchini Fritters with Feta, Mint and Yogurt", cuisine: "Greek", protein: "egg" },
  { n: 76, title: "Mushroom and Shallot Frittata", cuisine: "Italian-American", protein: "egg" },
  { n: 77, title: "Loaded Sweet Potato Nachos with Black Beans", cuisine: "Tex-Mex", protein: "legume" },
  { n: 78, title: "Black Bean Chili", cuisine: "Tex-Mex", protein: "legume", tags: ["pantry"] },
  { n: 79, title: "White Bean and Kale Soup with Fire-Roasted Tomatoes", cuisine: "Italian-American", protein: "legume", tags: ["pantry"], replacesKm30: "36b57bde" },
  { n: 80, title: "Vegetarian White Bean Meatballs in Marinara", cuisine: "Italian-American", protein: "legume", shortcut: "jarred marinara" },
  { n: 81, title: "Spaghetti Carbonara", cuisine: "Italian", protein: "pork", tags: ["pantry"], replacesKm30: "9bd8aeec" },
  { n: 82, title: "Cacio e Pepe", cuisine: "Italian", protein: "cheese", tags: ["pantry"], replacesKm30: "23e8535e" },
  { n: 83, title: "Spaghetti Puttanesca", cuisine: "Italian", protein: "fish", tags: ["pantry"] },
  { n: 84, title: "One-Pot Cheeseburger Pasta", cuisine: "American", protein: "beef" },
  { n: 86, title: "Saucy Gochujang Noodles with Chicken", cuisine: "Korean-American", protein: "chicken" },
  { n: 87, title: "Sichuan Noodles with Sesame Chili Oil", cuisine: "Sichuan", protein: "vegetarian" },
  { n: 90, title: "One-Pot French Onion Pasta with Gruyère", cuisine: "French-American", protein: "cheese" },
  { n: 91, title: "Crispy Sheet-Pan Gnocchi with Burst Tomatoes and Mozzarella", cuisine: "Italian-American", protein: "cheese", shortcut: "shelf-stable potato gnocchi", replacesKm30: "45077d29" },
  { n: 92, title: "One-Pot Creamy Tomato Basil Pasta Bake", cuisine: "Italian-American", protein: "cheese" },
  { n: 93, title: "One-Pot Creamy Tortellini with Greens and Artichokes", cuisine: "Italian-American", protein: "cheese", shortcut: "refrigerated cheese tortellini" },
  { n: 94, title: "Taco Gnocchi Bake", cuisine: "Tex-Mex", protein: "beef", shortcut: "shelf-stable potato gnocchi; canned enchilada sauce" },
  { n: 96, title: "One-Pan Balsamic Chicken and Asparagus", cuisine: "Italian-American", protein: "chicken", shortcut: "bottled balsamic glaze" },
  { n: 97, title: "One-Pan Cheesy Broccoli-Cheddar Orzo", cuisine: "American", protein: "cheese" },
  { n: 98, title: "One-Pan Tuna Pasta with Capers and Olives", cuisine: "Italian", protein: "fish", tags: ["pantry"] },
  { n: 99, title: "Sheet-Pan Green Chile Chicken Nachos", cuisine: "Tex-Mex", protein: "chicken", shortcut: "rotisserie chicken; tortilla chips" },
  { n: 101, title: "Marry Me Beans with Crusty Bread", cuisine: "Italian-American", protein: "legume", tags: ["pantry"] },
  { n: 102, title: "Linguine with Tuna, Capers and Lemon", cuisine: "Italian", protein: "fish", tags: ["pantry"] },
  { n: 103, title: "Kimchi and Spam Fried Rice", cuisine: "Korean", protein: "pork", shortcut: "day-old cooked rice", tags: ["pantry", "fridge-rescue"] },
  { n: 105, title: "Clean-Out-the-Fridge Chicken and Vegetable Quesadillas", cuisine: "Tex-Mex", protein: "chicken", shortcut: "leftover cooked chicken; jarred salsa", tags: ["fridge-rescue"] },
  { n: 107, title: "Pasta e Ceci", cuisine: "Italian", protein: "legume", tags: ["pantry"] },
  { n: 108, title: "Spinach, Black Bean and Chipotle Quesadillas", cuisine: "Tex-Mex", protein: "legume", tags: ["pantry"] },
  { n: 109, title: "White Bean and Tuna Salad with Arugula", cuisine: "Italian", protein: "fish", tags: ["pantry"] },
  { n: 110, title: "Freezer Dumpling Soup with Bok Choy", cuisine: "Asian-American", protein: "pork", shortcut: "frozen dumplings; carton chicken broth", tags: ["pantry"] },
  { n: 111, title: "Oyakodon (Chicken and Egg Rice Bowl)", cuisine: "Japanese", protein: "chicken" },
  { n: 112, title: "Chicken with Warm Bulgur Pilaf, Tomatoes and Feta", cuisine: "Mediterranean", protein: "chicken" },
  { n: 114, title: "Garlic Shrimp with Basil, Tomatoes and Chili Flakes", cuisine: "Italian-American", protein: "shrimp" },
  { n: 115, title: "Air Fryer Garlic-Paprika Shrimp", cuisine: "American", protein: "shrimp" },
  { n: 116, title: "Vegan Creamy Mushroom Miso Ramen", cuisine: "Japanese-American", protein: "mushroom", shortcut: "instant ramen noodle bricks (seasoning packets not used)", tags: ["pantry"] },
  { n: 117, title: "Quick Chana Masala", cuisine: "Indian", protein: "legume", tags: ["pantry"], replacesKm30: "3203f02d" },
  { n: 118, title: "Chickpea Salad Stuffed Avocados", cuisine: "American", protein: "legume" },
  { n: 119, title: "Smoked Salmon Toast with Herbed Cottage Cheese", cuisine: "Scandinavian-American", protein: "salmon", shortcut: "smoked salmon" },
  { n: 120, title: "Brussels Sprout and Tempeh Stir-Fry", cuisine: "Asian", protein: "tempeh" },
];

/** The 10-meal test (D-WS9-375): one of each method and protein the shelf needs. */
export const TEST10 = [1, 14, 28, 37, 45, 51, 59, 81, 99, 107];
