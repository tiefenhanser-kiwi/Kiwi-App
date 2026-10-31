# CAT-QUICK-1 B — the 120 concepts against the dev catalog (2026-10-30)

Matched by dish name and defining ingredients (candidates: `scripts/_scratch/cat-quick-1/dedup.ts`,
top 4 per concept by shared title words ×3 + shared ingredient words, plus a name grep), verdicts by hand.
Times are the stamped total / hands-on (minutes). Population: catalog meals (`userId` null, not archived).

**Result: 90 to build** (6 of them replace a km30 meal), **9 skipped** (already ≤30, or a km30 meal ≤35),
**21 already exist but stamp over 30** (not built; see the end).

## Skipped — already in the catalog at ≤30, or as a km30 meal at ≤35 (Hans's rule)

| # | Concept | Existing meal | Stamp |
|---|---|---|---|
| 11 | Chicken scampi | 9d693c64 Spicy Chicken Scampi with Cherry Tomatoes over Linguine | 28/27 |
| 21 | Chicken lettuce wraps | km30 8ea8d5c5 Korean Chicken Lettuce Wraps with Rice | 30/28 |
| 26 | Smash burger tacos | km30 c07e5532 Smash Burger Tacos with Pickles and Onions | 35/32 |
| 27 | Korean ground beef bowls | km30 68be520e Korean Beef Bowls with Rice and Quick Pickles | 27/27 |
| 30 | Philly cheesesteak | km30 c7e644eb Philly Cheesesteaks with Kettle Chips and Pickles | 22/19 |
| 49 | Classic shrimp scampi | c70a4986 Shrimp Scampi over Angel Hair Pasta | 28/26 |
| 88 | Garlic butter shrimp angel hair | c70a4986 (same meal as #49) | 28/26 |
| 106 | 3-ingredient stovetop mac | 7fc37e55 / 7de499a8 / cd951211 Stovetop Mac and Cheese ×3 | 25 / 23 / 28 |
| 113 | Shrimp fried rice | fef8c272 Spicy Garlic Shrimp Fried Rice | 28/28 |

## Built, replacing a km30 meal that stamps over 35 (archived when the rebuild stamps ≤30)

| # | Concept | km30 meal | Stamp |
|---|---|---|---|
| 7 | Chicken paillard with lemon-herb butter | 69c7fb8e Grilled Chicken Paillard with Couscous and Arugula | 36/31 |
| 79 | White bean and kale soup | 36b57bde White Bean and Kale Soup with Grilled Cheese | 50/30 |
| 81 | Spaghetti carbonara | 9bd8aeec Spaghetti Carbonara with Peas and Green Salad | 38/33 |
| 82 | Cacio e pepe | 23e8535e Cacio e Pepe with a Green Salad | 36/24 |
| 91 | Sheet-pan gnocchi, burst tomatoes, mozzarella | 45077d29 Sheet-Pan Gnocchi with Tomatoes, Broccolini, and Lemon Salad | 47/20 |
| 117 | 10-minute chana masala | 3203f02d Chana Masala with Naan and Cucumber Raita | 54/46 |

## Built — near-duplicates (same family, a different dish or method; nothing archived)

| # | Concept | Nearest existing | Stamp |
|---|---|---|---|
| 1 | Marry me chicken | 3db74283 Prosciutto-Wrapped Chicken with Sun-Dried Tomato Cream Sauce | 54/31 |
| 12 | Chicken Caesar smash tacos | km30 3a0214d5 Chicken Caesar Wraps | 20/17 |
| 16 | Chicken tacos with green sauce | ffac4a79 Salsa Verde Pulled Chicken Tacos | 65/41 |
| 17 | Thai peanut chicken bowls | c6470ba9 Spicy Peanut Chicken Stir-Fry with Peppers and Cabbage | 41/40 |
| 19 | Butter chicken meatballs | ba14d4db Instant Pot Butter Chicken (and 3 more) | 55/31 |
| 25 | Tandoori-style yogurt chicken | km30 523839cf Chicken Tikka Bowls | 37/29 |
| 34 | Mongolian beef ramen | db67e8f5 Classic Mongolian Beef (and 2 more) | 46/42 |
| 35 | Sesame pork Milanese | df579680 Pork Milanese with Arugula | 42/39 |
| 44 | Leftover-salmon rice bowl | km30 37402563 Miso Soup with Salmon Rice Bowls (cooks its salmon; this one starts from leftovers — the D-WS9-363 pair #7 target) | 35/33 |
| 48 | Fish taco foil packets | ac3c05d5 Baja-Style Beer-Battered Fish Tacos (and 5 more) | 54/43 |
| 53 | Shrimp, orzo, feta, asparagus skillet | km30 57b5711b Shrimp Souvlaki with Lemon Orzo and Feta | 79/63 |
| 60 | Bang bang tofu | 0f29176e Bang Bang Shrimp | 45/45 |
| 61 | Spicy peanut tofu bowls | 75302ba2 Spicy Thai Peanut Noodles with Tofu | 43/43 |
| 66 | Eggs in purgatory | km30 431266f4 Shakshuka with Feta and Warm Bread | 46/33 |
| 70 | Lentil sloppy joes | 9555d55a Turkey Sloppy Joes (and 7 meat versions) | 42/38 |
| 73 | Vegan mushroom stroganoff | 5d236e13 Classic Beef Stroganoff (and 5 more) | 45/40 |
| 74 | Creamy mushroom-asparagus pasta (GF, DF) | r-pasta Creamy Mushroom Pasta (seed row, no steps) | — |
| 76 | Mushroom and shallot frittata | km30 79d5ac1e Spinach and Feta Frittata | 44/40 |
| 77 | Sweet potato nachos | 8b64165e Black Bean and Avocado Stuffed Sweet Potatoes | 65/21 |
| 78 | Black bean chili | 721c30f1 Roasted Sweet Potato and Black Bean Chili | 44/27 |
| 84 | One-pot cheeseburger pasta | 4db6c8e2 One-Pot Taco Pasta | 44/26 |
| 87 | Sichuan chili-oil noodles | 5d1cd871 Dan Dan Noodles | 41/41 |
| 103 | Kimchi and Spam fried rice | 1092ffb9 Kimchi Fried Rice with Fried Egg | 38/38 |
| 105 | Clean-out-the-fridge quesadilla | 7a154cc7 Cheese Quesadillas (and 9 more) | 55/52 |
| 107 | Pasta e ceci | add1ffea Pasta e Fagioli | 68/39 |
| 110 | Freezer dumpling soup | km30 0768b6b8 Egg Drop Soup and Pan-Fried Pork Dumplings | 30/25 |

## Built — new to the catalog (no meaningful match)

2 cowboy butter chicken · 10 lemon chicken-asparagus stir-fry · 13 gyro smash tacos · 14 sheet-pan crispy ramen ·
18 chicken parm meatball skillet · 20 creamy Dijon chicken · 22 Thai turmeric chicken noodles · 23 Southwest chicken skillet ·
24 charred-scallion chicken thighs · 28 beef and cabbage stir-fry · 31 palomilla · 32 Kenyan beef wet fry ·
36 pork chops pizzaiola · 37 pork and green onion stir-fry · 38 gochujang pork · 39 moo shu pork wraps ·
42 chili-lime air fryer salmon · 43 hot honey salmon bites · 45 salmon piccata · 50 chimichurri shrimp ·
51 camarones a la diabla · 54 Thai shrimp with chile jam · 56 baked feta pasta · 57 marry me chickpeas ·
59 chili crunch tofu · 62 cottage cheese pasta · 63 cacio e pepe white beans · 64 pizza beans · 65 broccoli-cheddar chickpeas ·
67 dense bean salad · 68 kale salad with crispy chickpeas · 69 portobello stir-fry · 71 noodle-free pad thai ·
72 poblano-portobello fajitas · 75 zucchini fritters · 80 white bean meatballs · 83 puttanesca · 86 gochujang chicken noodles ·
90 French onion pasta · 92 tomato basil pasta bake · 93 tortellini and greens · 94 taco gnocchi bake ·
96 balsamic chicken and asparagus · 97 broccoli-cheddar orzo · 98 one-pan tuna pasta · 99 green chile chicken nachos ·
101 marry me beans · 102 linguine with tuna · 108 spinach-black bean-chipotle quesadillas · 109 white bean and tuna salad ·
111 oyakodon · 112 chicken with bulgur pilaf · 114 garlic shrimp with basil and tomatoes · 115 air fryer shrimp ·
116 vegan mushroom ramen · 118 chickpea salad stuffed avocados · 119 smoked salmon toast · 120 Brussels sprout and tempeh stir-fry

## Not built — the dish already exists (not km30) and stamps over 30

Hans ruled only on km30 meals. These are the same dish as an existing catalog meal, so building them
would add a duplicate; a quick version of each could still be built if wanted (to reach 100).

| # | Concept | Existing (fastest) | Stamp |
|---|---|---|---|
| 3 | Butter chicken | ba14d4db Instant Pot Butter Chicken (+3) | 55/31 |
| 4 | Honey garlic chicken over rice | 546b2fba Honey Garlic Chicken Thighs with Soy and Ginger (+3) | 40/38 |
| 5 | Sheet-pan chicken fajitas | bd57e0d7 Classic Tex-Mex Sheet-Pan Chicken Fajitas (+3) | 41/20 |
| 6 | Chicken piccata | e38903bc Chicken Piccata with Lemon-Caper Sauce and Angel Hair (+3) | 38/31 |
| 8 | Chicken saltimbocca | cfc389fb Chicken Saltimbocca with White Bean and Arugula Salad (+2) | 42/39 |
| 9 | Chicken and broccoli stir-fry | 892fb206 Ginger-Soy Chicken Stir-Fry with Broccoli and Snap Peas | 37/31 |
| 15 | Sheet-pan chicken tinga bowls | 7728c5ee Chicken Tinga Rice Bowls (+3 tinga) | 56/52 |
| 29 | Egg roll in a bowl | 625f8521 Ginger Beef Egg Roll in a Bowl (+2) | 36/34 |
| 33 | Pepper steak | a0972e8a Ginger-Soy Pepper Steak (+1) | 44/35 |
| 40 | Sheet-pan gnocchi and sausage | d50ec95b Sheet-Pan Gnocchi with Sausage, Peppers, and Marinara | 45/18 |
| 41 | Honey-garlic glazed salmon | 9f74b96f Honey Garlic Salmon with Roasted Broccoli and Rice | 34/26 |
| 46 | Garlic butter cod | 1a38dade Garlic Butter Baked Cod with Roasted Asparagus | 35/18 |
| 47 | Baked cod with tomatoes | cd091acb Mediterranean Baked Cod with Tomatoes and Olives | 40/31 |
| 52 | Garlic shrimp tacos | a19ff990 Garlic-Butter Shrimp Tacos with Cotija | 46/44 |
| 55 | Salmon patties | 13a2816b Salmon Croquettes with Creamy Dill Sauce (+1) | 43/41 |
| 58 | Curried chickpeas with spinach | 2e4e3437 Chickpea Coconut Curry with Basmati and Naan | 47/33 |
| 85 | 15-minute lo mein | 86fd104b Garlic-Soy Vegetable Lo Mein (+7) | 32/32 |
| 89 | Chicken pesto pasta | 9cc387de Pesto Pasta with Grilled Chicken | 46/46 |
| 95 | White bean and smoked sausage skillet | 5034d656 Sausage and Kale White Bean Skillet | 54/32 |
| 100 | One-pot chili mac | 7763e28d Smoky Turkey Chili Mac (+5) | 39/25 |
| 104 | Black bean burrito bowl | a52b28b4 Black Bean and Roasted Corn Burrito Bowl | 51/50 |
