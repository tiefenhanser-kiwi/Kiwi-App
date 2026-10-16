# CAT-Q0 — catalog quality, production

1311 of 1314 meals reviewed (rubric c497f2ae220e, claude-sonnet-5-5). Verdicts: ok 576 · fix 705 · block 30. Featured: ok 13 · fix 12 · block 0.

## Issues by class × severity

Classes: 1 can't work as written · 2 ingredients and steps disagree · 3 units · 4 missing prerequisites · 5 safety and technique · 6 swaps that aren't shortcuts · 7 times that lie.

| class | block | fix | polish | total |
|---|---|---|---|---|
| 1 | 4 | 68 | 65 | 137 |
| 2 | 10 | 93 | 222 | 325 |
| 3 | 0 | 89 | 231 | 320 |
| 4 | 0 | 28 | 111 | 139 |
| 5 | 16 | 482 | 104 | 602 |
| 6 | 0 | 54 | 28 | 82 |
| 7 | 0 | 31 | 84 | 115 |
| all | 30 | 845 | 845 | 1720 |

## The 20 most-planned meals first

Ranked by MealPlanItem count (how many plans include the meal), then template-item count, then live Featured membership. Meal.useCount, saveCount, likeCount and timesCooked are all 0 on dev, so they are not used. On this database 1 catalog meal(s) are in any plan (a plan holds a forked copy with its own meal id), and 26 are in a plan template, so in practice the order is template membership — the live Featured plans first.

### Salmon with Rice Pilaf — fix

`dev-meal-salmon-rice-pilaf` · in 1 plans · 1 template items

- **fix · class 3** — Seared Salmon · ingredient "4 6 oz salmon fillets": "4 6 oz salmon fillets" — The count and the weight run together as two bare numbers, so the line reads as '4 6 oz' with no clear unit. **Fix:** Print as '4 salmon fillets (6 oz each)'.

### Beef Keema Curry with Peas — fix

`ecf4a7b1-90ee-49c8-a7df-718093a4dadf` · in 0 plans · 1 template items · Featured: featured-cozy-weeknights

- **fix · class 5** — Beef Keema Curry with Peas · ingredient "1½ pounds ground beef (85% lean)" · step 7: "cooking over medium-high heat for 6–7 minutes until no pink remains and the meat is lightly browned" — Ground beef must reach 160°F, and colour ("no pink") and time alone are not an accepted doneness check. **Fix:** Add: cook until an instant-read thermometer reads 160°F in the meat (the later 10-minute simmer does not replace the check).

### Broccoli Cheddar Soup with Crisp Apple and Walnut Salad — ok

`2b62e777-366a-41bc-9abf-845c1c1ce0fe` · in 0 plans · 1 template items · Featured: featured-cozy-weeknights

No issues.


### Cajun Grilled Salmon with Corn and Tomato Salad — ok

`4b7a54f6-eb31-43b7-a85c-5e763cc1e40c` · in 0 plans · 1 template items · Featured: featured-healthy-reset

- **polish · class 3** — Charred Corn and Tomato Salad · ingredient "2 tablespoons lime juice (freshly squeezed)" · step 1: "2 tablespoons fresh lime juice" — Fresh-squeezed lime juice is listed but no limes are listed to buy. **Fix:** Replace with '2 limes (juiced, about 2 tablespoons)'.
- **polish · class 4** — Charred Corn and Tomato Salad · step 2: "Place the husked corn ears directly on the hot grill grates" — The corn relies on the grill preheated in the salmon dish but does not say to grill it before or alongside the salmon. **Fix:** Add 'Grill the corn while the grill preheats or just before the salmon goes on' to the step.

### Chicken Fried Rice with Egg and Peas — fix

`a1948dff-d093-42ca-a9d9-c849f12b6161` · in 0 plans · 1 template items · Featured: featured-family-favorites

- **fix · class 5** — Chicken Fried Rice with Egg and Peas · step 3: "then stir and cook 2 more minutes until cooked through; transfer to a plate." — Poultry doneness is given only as 'cooked through' with no 165°F temperature or valid check. **Fix:** Add: cook until an instant-read thermometer reads 165°F in the thickest piece.
- **polish · class 7** — Sesame Cucumber Salad · step 1: "Let the salted cucumber sit for 10 minutes, then pat dry with paper towels." — Step 0 already has the cucumber stand 10 minutes, so the wait is duplicated and could be read as 20 minutes. **Fix:** Remove 'let stand 10 minutes' from step 0 or merge it with step 1 so the wait is stated once.

### Classic Beef Stroganoff over Egg Noodles — ok

`5d236e13-0651-4b91-b48b-c27a2d73e644` · in 0 plans · 1 template items · Featured: featured-cozy-weeknights

- **polish · class 4** — Creamy Beef and Mushroom Stroganoff · ingredient "¾ cup sour cream (room temperature)" · step 8: "stir in ¾ cup room-temperature sour cream until fully incorporated" — No earlier step tells the cook to take the sour cream out of the fridge ahead of time to reach room temperature. **Fix:** Add a note in prep: set the sour cream out 30 minutes before cooking.

### Classic Lentil Soup — ok

`6ce70910-a7a9-4a23-9a32-9c68a3e8fcb5` · in 0 plans · 1 template items · Featured: featured-cozy-weeknights

No issues.


### Classic Tex-Mex Ground Beef Tacos — fix

`5edebecb-4190-45ed-8624-6945f80031f0` · in 0 plans · 1 template items · Featured: featured-family-favorites

- **fix · class 5** — Seasoned Ground Beef Taco Filling · step 3: "cook, breaking it up with a spoon, until browned and no pink remains, about 7 minutes" — Ground beef must reach 160°F, and the step gives only colour and time as the doneness check, with no temperature anywhere in the recipe. **Fix:** Add: cook until the beef reaches 160°F on an instant-read thermometer (check a few spots) before draining.

### Classic Tomato-Vegetable Minestrone with Ditalini — fix

`b12c9ff5-7cad-439b-bce9-82419a06808f` · in 0 plans · 1 template items · Featured: featured-healthy-reset

- **fix · class 7** — Classic Tomato-Vegetable Minestrone with Ditalini: "Stir in the cannellini beans and 6 oz dry ditalini and cook for 9–10 minutes" — The steps total about 63 minutes (23 prep plus 37 cook plus 3 assemble), mostly attended, yet the derived total is 40 minutes. **Fix:** Correct the derived total to roughly 60 minutes, or state clearly that prep overlaps the cook steps.

### Creole Vegetarian Red Beans and Rice — ok

`683abea5-564d-4400-817f-ef7b9785a772` · in 0 plans · 1 template items · Featured: featured-budget-bowls

- **polish · class 2** — Creole Red Beans with the Holy Trinity · ingredient "1 teaspoon kosher salt" · step 6: "1 teaspoon kosher salt, ½ teaspoon black pepper, and 2 bay leaves" — Full salt is added on top of canned beans and store-bought Creole seasoning (usually salty) with no note to reduce it when the swap is used. **Fix:** Add 'use ½ teaspoon salt if using store-bought Creole seasoning; adjust at the end'.

### Crispy Herb-Roasted Chicken Thighs with Roasted Potatoes and Green Beans — fix

`e251f17b-752a-4704-8b13-25ae0acae31b` · in 0 plans · 1 template items · Featured: featured-sheet-pan-easy

- **fix · class 3** — Crispy Herb-Roasted Chicken Thighs · ingredient "1 teaspoon lemon zest" · step 2: "1 teaspoon lemon zest" — Zest is listed with no lemon to buy, and the green beans also list only lemon juice, so no lemon appears anywhere on the shopping list. **Fix:** Add '1 lemon' to the shopping list (zest it for the chicken, then juice it for the green beans), or print the zest as '1 lemon (zested)'.

### Ginger Beef Egg Roll in a Bowl — fix

`625f8521-a6dd-4d41-ad62-a54cefd69a2c` · in 0 plans · 1 template items · Featured: featured-healthy-reset

- **fix · class 5** — Ginger Beef Egg Roll in a Bowl · step 6: "cook, breaking it up, for 6–7 minutes until browned and cooked through; drain excess fat." — Ground beef must reach 160°F, and the step gives only a time and 'cooked through' with no temperature or valid doneness check. **Fix:** Add: 'cook until an instant-read thermometer reads 160°F in the beef, then drain excess fat.'

### Herb Garlic Butter Chicken Bites with Rosemary and Parmesan — fix

`3ab32cd0-15c0-40b9-a2b0-28dc83720ee0` · in 0 plans · 1 template items · Featured: featured-family-favorites

- **fix · class 5** — Herb Garlic Butter Chicken Bites with Rosemary and Parmesan · step 4: "cook 2–3 minutes more until cooked through and golden on all sides" — Poultry doneness is given only as time and 'cooked through', with no 165°F temperature or equivalent check. **Fix:** Add: cook until a thermometer in the thickest cube reads 165°F (also reiterate in step 6).
- **fix · class 1** — Herb Garlic Butter Chicken Bites with Rosemary and Parmesan · ingredient "2 pounds boneless skinless chicken breasts (cut into 1-inch cubes)" · step 3: "add the chicken bites in a single layer and sear undisturbed for 3 minutes" — 2 lb of 1-inch cubes cannot fit in a single layer in one large skillet, so they would steam rather than sear. **Fix:** Sear in two batches (about 1 lb each), adding oil for the second batch, or use two skillets.
- **polish · class 7** — Herb Garlic Butter Chicken Bites with Rosemary and Parmesan · step 3: "Heat 1 tablespoon olive oil in a large skillet over medium-high until shimmering" — Step indices skip from 1 to 3, so a step appears to be missing or the numbering is broken. **Fix:** Renumber the steps, or restore the missing step if one was dropped.

### Honey Garlic Glazed Chicken Thighs with Steamed Rice and Broccoli — ok

`cde76c81-8392-4ff6-af43-faf8b2ac982c` · in 0 plans · 1 template items · Featured: featured-budget-bowls

- **polish · class 4** — Honey Garlic Glazed Chicken Thighs · step 8: "roast in a 400 °F oven for 18–20 minutes until the internal temperature reaches 165 °F" — The oven is never preheated by any earlier step, so the cook may put the skillet into a cold oven. **Fix:** Add a preheat step at the start: 'Preheat the oven to 400°F.'

### Korean Beef Bowl with Steamed Rice, Cucumber Kimchi, and a Fried Egg — fix

`6929ad67-5b44-4e78-9daf-ef4c6e7f8d13` · in 0 plans · 1 template items · Featured: featured-budget-bowls

- **fix · class 5** — Korean Soy-Sesame Ground Beef · step 5: "until browned and no pink remains" — Ground beef must reach 160°F, and colour alone is not an accepted doneness check; no temperature is given anywhere. **Fix:** Add: cook until an instant-read thermometer reads 160°F in the beef.
- **polish · class 3** — Korean Soy-Sesame Ground Beef · ingredient "4 teaspoon pre-minced garlic": "4 teaspoon pre-minced garlic" — The swap's unit is ungrammatical and reads like a malformed amount (should be 'teaspoons'). **Fix:** Change to '4 teaspoons pre-minced garlic'.

### Lemon-Herb Sheet-Pan Salmon and Asparagus — fix

`4e5005f6-3b1d-44fe-867a-7ce0993e3bf1` · in 0 plans · 1 template items · Featured: featured-sheet-pan-easy

- **fix · class 1** — Roasted Asparagus with Garlic and Lemon · ingredient "1½ pounds asparagus (woody ends snapped off)" · step 1: "Toss the asparagus on the second half of the sheet pan" — 1½ lb of asparagus on half a pan shared with four fillets will overlap and steam rather than crisp the tips as promised. **Fix:** Roast the asparagus on its own rimmed sheet pan in a single layer (or reduce to 1 lb), and update the salmon step to use the whole pan.
- **polish · class 7** — Garlic Herb Roasted Baby Potatoes · step 3: "Spread the potatoes cut-side down on a separate rimmed sheet pan and roast at 425°F for 20 minutes." — The potatoes need about 31 minutes while the salmon and asparagus need 13, but no step tells the cook to start the potatoes about 18 minutes before the fish goes in. **Fix:** Add a note: put the potatoes in first, and add the salmon and asparagus pan when the potatoes have about 13 minutes left.

### Lentil Dal with Steamed Basmati Rice — ok

`1107775b-c2fe-46b2-89b1-b884dee445c0` · in 0 plans · 1 template items · Featured: featured-budget-bowls

No issues.


### Pepperoni and Mushroom Pizza — ok

`8f6a4824-cab8-451e-9115-cab26a85172a` · in 0 plans · 1 template items · Featured: featured-family-favorites

No issues.


### Potato Leek Soup with Crusty Bread and a Simple Green Salad — ok

`42c9c80d-163b-4ecc-a597-0d8d0b8675c6` · in 0 plans · 1 template items · Featured: featured-cozy-weeknights

- **polish · class 2** — Potato Leek Soup · step 5: "Pour in 5 cups low-sodium chicken broth, stir in 1½ teaspoons kosher salt and ½ teaspoon black pepper" — The step indices skip from 5 to 7, which is cosmetic and loses no content. **Fix:** Renumber the soup steps consecutively.

### Ratatouille with Crusty French Bread — ok

`afb31db3-6e90-4eca-9759-2b1a1d8c8ed6` · in 0 plans · 1 template items · Featured: featured-healthy-reset

No issues.


## Every block issue (30)

- Chicken Pho with Fresh Spring Rolls (`05ccd03e-2e8b-49e8-bbb1-7823f9d9a9c7`) — class 5 · Chicken Pho · ingredient "1 whole chicken (about 3.5–4 lb, rinsed)" · step 3: "1 whole chicken (about 3.5–4 lb, rinsed)" — The recipe tells the cook to rinse raw poultry (also 'Place the rinsed whole chicken' in step 3), which USDA advises against because it spreads bacteria. **Fix:** Remove 'rinsed' from the ingredient line and step 3; pat the chicken dry instead.
- Tuna Melts with Tomato Soup (`0749b4f1-fe0a-47b9-885b-cf33ce3bae4c`) — class 1 · Tuna Melts · ingredient "60 ounces canned tuna in water (drained well (five 12 oz cans))" · step 0: "60 ounces canned tuna in water (drained well (five 12 oz cans))" — 60 oz of tuna (about 9 cups drained) for 8 open-faced slices is about 7 oz per slice, far more than the bread can hold, and ⅓ cup mayo cannot bind it or fit the bowl and sheet; the 12 oz cans are also not a normal size. **Fix:** Use about 20 oz tuna (four 5 oz cans, drained), and update the step 0 text to match.
- Creamy Chicken Broccoli Rice Casserole (`16dbd2aa-66d4-4825-bd5d-26cfbe89ab79`) — class 5 · Creamy Chicken Broccoli Rice Casserole · step 7: "until golden on the outside but not fully cooked through; transfer to a plate." — Chicken is left raw inside and no step ever gives a 165°F internal temperature or equivalent check after baking. **Fix:** Add to step 13: bake until chicken reaches 165°F in the thickest cubes and rice is tender before resting.
- BBQ-Glazed Pork Chops with Tangy Coleslaw and Baked Beans (`25f049a8-0f60-464f-90e0-a6cca4bb7a5e`) — class 5 · BBQ-Glazed Pork Chops · step 5: "until grill marks form and the internal temperature reaches 135°F." — A pork chop temperature below 145°F is stated as a target, and a cook could stop at 135°F, which is under the 145°F minimum. **Fix:** Change step 5 to 'until grill marks form, about 4–5 minutes per side' (or say the chops are not done yet at 135°F) and keep 145°F only in step 6.
- Sous Vide Shawarma Chicken Breast over Bulgur with Roasted Red Pepper, Hummus, and Parsley (`2fbb2a37-a72e-4c3c-8862-266f07db869c`) — class 5 · Sous Vide Shawarma Chicken Breast · step 4: "cook sous vide at 145°F for 1 hour 30 minutes" — 145°F is below the 165°F poultry minimum and no 165°F check is given anywhere. **Fix:** Set the bath to 150-165°F with a time that pasteurizes to 165°F equivalent, or finish by checking the chicken reads 165°F with a thermometer.
- Classic Sauced BBQ Chicken Halves with Grilled Corn and Creamy Coleslaw (`3db20bcd-abb6-4b40-a209-bdf94488c9a9`) — class 5 · Classic Sauced BBQ Chicken Halves · step 6: "until an instant-read thermometer inserted in the thickest part reads 155°F" — Poultry must reach 165°F, and a cook can stop at the 155°F stated here instead of waiting for step 7. **Fix:** Change step 6 to cook until the thickest part reads about 155–160°F before saucing, but state clearly that the chicken is not done until it reaches 165°F, or simply say 'reads 160°F' and finish to 165°F in step 7.
- BBQ Grilled Chicken and Charred Corn Plate (`5c5631d8-a206-46f0-8583-70446fc53008`) — class 5 · BBQ Grilled Chicken Thighs · step 4: "until grill marks form and the internal temperature reaches 155°F" — 155°F is below the 165°F poultry minimum, and a cook could stop at this first stated temperature. **Fix:** Change the step to say grill until grill marks form and the chicken reaches about 150°F, with the final 165°F check kept in the next step, or simply state 165°F here.
- Classic Chicken Cheesesteak with Provolone, Peppers, and Onions (`71cbb581-28b1-417e-b459-a520a9e6eef6`) — class 1 · Old Bay Seasoned Oven Fries · ingredient "2 pounds russet potatoes (cut into ¼-inch sticks, skin on)" · step 4: "Carefully spread the seasoned fries in a single layer on the preheated baking sheet, making sure they are not touching" — 2 lb of ¼-inch potato sticks cannot lie in a non-touching single layer on one baking sheet, so they would steam instead of crisp. **Fix:** Divide the fries between two preheated rimmed baking sheets (swap them between racks when flipping).
- Sous Vide Italian Herb Pork Loin over Farro with White Beans, Sun-Dried Tomatoes, and Arugula (`7aa8acb9-1741-44f2-88ec-36d12450f569`) — class 5 · Sous Vide Italian Herb Pork Loin · step 3: "Preheat your sous vide circulator in a large pot or container to 140°F (60°C)." — Pork loin must reach 145°F per the doneness rule, and the recipe states only 140°F, below the minimum, with no 145°F check. **Fix:** Set the bath to 145°F (63°C) in steps 3 and 4, or state that the pork must reach 145°F internally before the rest.
- Sous Vide Lemon-Oregano Chicken Breast over Quinoa Tabbouleh with Cucumber and Feta (`898f3f40-a8ff-48cb-b5ec-b46aae672b8f`) — class 5 · Sous Vide Lemon-Oregano Chicken Breast · step 3: "Submerge the sealed bag in the 140°F water bath and cook for 1 hour." — Chicken is cooked at a 140°F bath, below the 165°F poultry minimum, and no 165°F internal temperature or equivalent check is given anywhere. **Fix:** Tell the cook to verify the chicken reaches 165°F (e.g., set the bath to 150°F+ with a longer hold and probe to 165°F, or finish in the sear until the thickest part reads 165°F).
- BBQ-Glazed Spatchcock Grilled Chicken with Grilled Corn and Creamy Coleslaw (`8a9e026d-c26e-425e-8d9c-56077458a60b`) — class 5 · BBQ-Glazed Spatchcock Grilled Chicken · step 7: "grill 30–35 minutes until a thermometer in the thickest part of the thigh reads 155°F" — Poultry must reach 165°F, and a stated target of 155°F below the minimum could lead the cook to stop there, even though step 8 later says 165°F. **Fix:** Change step 7 to read 'until the thigh reads about 150–155°F before glazing' only if the final 165°F check stays. Safer: say 'until the thigh reaches 165°F, glazing in the last few minutes'.
- Hyderabadi Dum Chicken Biryani (`957696fb-c0f4-486c-868d-658036b0db68`) — class 5 · Hyderabadi Dum Chicken Biryani · step 1: "marinate at room temperature while you prepare everything else" — Raw chicken sits in a yogurt marinade at room temperature through the 20–25 minute onion fry and the rest of the prep, with no time limit, which risks a danger-zone hold. **Fix:** Marinate covered in the refrigerator (at least 30 minutes, up to overnight), or cap the room-temperature hold at 30 minutes.
- BBQ-Glazed Beer Can Chicken with Roasted Corn and Creamy Coleslaw (`98825a51-664f-41b4-a050-a0b4d6fc42df`) — class 5 · BBQ-Glazed Beer Can Chicken · step 6: "until the thickest part of the thigh reads 155°F on an instant-read thermometer (it will carry over to 165°F while resting)" — Pulling poultry at 155°F is below the 165°F minimum, and a cook can stop at that first temperature. **Fix:** Roast until the thickest part of the thigh reads 165°F (and the breast reads 165°F) on an instant-read thermometer, then rest.
- Crawfish Boil with French Bread and Coleslaw (`a39f8044-9f1c-4ee7-b660-abcf8dd4e168`) — class 1 · Cajun Crawfish Boil with Corn and Red Potatoes · ingredient "5 quarts water" · step 0: "Fill a 40-quart stockpot with 5 quarts of water and bring to a rolling boil over high heat." — 5 quarts of water cannot cover 10 lb of crawfish plus potatoes, corn, sausage, onions and lemons, so the boil cannot cook or keep boiling as written. **Fix:** Use about 6 gallons (24 quarts) of water in the 40-quart pot, or cut the crawfish and vegetables to what 5 quarts can cover.
- Spatchcocked Roast Chicken with Smoked Paprika, Roasted Potatoes, and Garlic Green Beans (`b873f58d-064f-4244-bf2d-9f236b40de2a`) — class 5 · Spatchcocked Roast Chicken with Smoked Paprika · step 6: "until the breast registers 160°F and the thigh registers 175°F on an instant-read thermometer" — Poultry must reach 165°F, and a cook can stop when the breast reads 160°F, which is below the minimum. **Fix:** Change to 'until the breast registers 165°F and the thigh registers 175°F'.
- Garlic and Rosemary Pork Chops with Grilled Peaches and Arugula (`c6c51b81-c488-4ff3-b01e-a5ae913c7478`) — class 5 · Garlic and Rosemary Bone-In Pork Chops · step 4: "until the internal temperature reaches 140°F and deep grill marks form" — Pork chops must reach 145°F with a rest, and 140°F is below that minimum. **Fix:** Change to 'until the internal temperature reaches 145°F', then rest 5 minutes.
- Crispy Baked Chicken Parmesan with Spaghetti and Garlic Green Beans (`c98dc177-14c7-4025-aee3-a21a32eb5849`) — class 5 · Crispy Baked Chicken Parmesan · step 6: "until the coating is deep golden and the internal temperature reaches 160°F" — Poultry must reach 165°F, so a cook stopping at 160°F would undercook the chicken. **Fix:** Change to 'internal temperature reaches 165°F' (and check again after the cheese bake).
- BBQ Chicken Thighs with Grilled Corn on the Cob and Watermelon Slaw (`e287b33b-d13c-465a-b558-717a4bebf8ed`) — class 5 · BBQ Glazed Chicken Thighs · step 2: "until grill marks form and the internal temperature reaches 155°F" — 155°F is below the 165°F poultry minimum, and a cook could stop at this first stated temperature even though step 4 gives 165°F. **Fix:** Change step 2 to say cook until grill marks form and the thickest part reaches about 150°F, then finish after glazing until 165°F is reached; or remove the temperature from step 2 and keep 165°F as the only target.
- Classic BBQ Beer Can Chicken with Roasted Corn and Garlic Red Potatoes (`e76ad75c-8041-4b79-b790-40b36eaf9adc`) — class 5 · Classic BBQ Beer Can Chicken · step 6: "until the breast reads 160°F and the thigh reads 175°F on an instant-read thermometer" — A breast reading of 160°F is below the 165°F poultry minimum, and a cook could stop there. **Fix:** Change to 'until the breast reads 165°F and the thigh reads 175°F'.
- Roasted Veg Buddha Bowl (`r-buddha`) — class 2 · Roasted Veg Buddha Bowl · ingredient "1 large sweet potatoes": "1 large sweet potatoes" — The dish has an empty steps list, so none of the seven ingredients (sweet potato, beets, kale, quinoa, tahini, lemon, pumpkin seeds) is used and the cook has no instructions to roast, cook or assemble anything. **Fix:** Add full default-path steps: preheat the oven, roast the cubed sweet potato and beets, cook the quinoa in water, massage the kale, make a lemon-tahini dressing, and assemble the bowls topped with pumpkin seeds.
- Coconut Chickpea Curry (`r-curry`) — class 2 · Coconut Chickpea Curry · ingredient "2 cans chickpeas": "2 cans chickpeas" — The dish has no steps at all, so none of the eight listed ingredients (chickpeas, coconut milk, tomatoes, onion, ginger, garam masala, rice, cilantro) is used and the cook has no instructions, including for cooking the rice. **Fix:** Add full steps: saute onion and ginger, bloom garam masala, add tomatoes, chickpeas and coconut milk and simmer, cook the basmati rice with water, and garnish with cilantro.
- Mediterranean Grain Bowl (`r-grain-bowl`) — class 2 · Mediterranean Grain Bowl · ingredient "1 cup quinoa": "1 cup quinoa" — The dish lists eight ingredients but has zero steps, so no ingredient is used and the cook has no method (quinoa cooking, dressing, assembly), and total/hands-on times are null. **Fix:** Add steps: rinse and simmer quinoa in 2 cups water ~15 min, drain and rinse the chickpeas, chop the vegetables, whisk lemon juice with olive oil, then toss everything together and top with feta and parsley.
- Creamy Mushroom Pasta (`r-pasta`) — class 2 · Creamy Mushroom Pasta · ingredient "1 lb pappardelle": "1 lb pappardelle" — The dish has eight ingredient lines but zero steps, so no ingredient is used by any step and the cook has no method to follow. **Fix:** Add full steps: boil the pappardelle, saute the mushrooms, shallot and garlic in butter, add the cream, thyme and Parmesan, then toss with the pasta and serve.
- Margherita Pizza Night (`r-pizza`) — class 2 · Margherita Pizza Night · ingredient "1 lb pizza dough": "1 lb pizza dough" — The dish has no steps at all, so none of the six listed ingredients is used and the cook has no instructions (no preheat, shaping, baking or timing). **Fix:** Add default-path steps: preheat the oven to 500°F with a pizza stone or sheet, stretch the dough, top with crushed tomatoes, garlic, oil and mozzarella, bake 8-12 minutes, then add basil.
- Lemon Herb Salmon (`r-salmon`) — class 2 · Lemon Herb Salmon · ingredient "1 cup wild rice": "1 cup wild rice" — The dish has no steps at all, so no ingredient (salmon, wild rice, asparagus, lemon, garlic, oil, dill) is used and the cook has no method to follow. **Fix:** Add full steps: cook the wild rice (about 3 cups water, 45-55 min), roast the asparagus, and sear or bake the salmon with the garlic, lemon, oil and dill.
- Garlic Shrimp Scampi (`r-shrimp`) — class 2 · Garlic Shrimp Scampi · ingredient "1 lb linguine": "1 lb linguine" — The dish has an empty steps list, so no step uses any listed ingredient (linguine, shrimp, garlic, wine, lemons, butter, parsley, pepper flakes) and the cook has no recipe to follow. **Fix:** Add full default-path steps: boil and drain the linguine, sauté the garlic and shrimp in butter, add the wine, lemon and pepper flakes, toss with the pasta and parsley.
- Hearty Lentil Stew (`r-stew`) — class 2 · Hearty Lentil Stew · ingredient "2 cups green lentils": "2 cups green lentils" — The dish has no steps at all, so none of the eight listed ingredients is used and the cook has no method (no sauté, simmer time, or bread instructions), and total/hands-on times are null. **Fix:** Add steps: sauté the onion, carrots and celery; add lentils, tomatoes, broth and bay leaves; simmer about 30-40 minutes until the lentils are tender; remove the bay leaves, season, and serve with the sliced bread.
- Chicken Veggie Stir-fry (`r-stirfry`) — class 2 · Chicken Veggie Stir-fry · ingredient "1 lb chicken breast": "1 lb chicken breast" — The dish has an empty steps list, so none of the eight listed ingredients is used by any step and the cook has no method, cook times, rice water, or the 165°F chicken doneness temperature. **Fix:** Add full steps: cook the brown rice, slice and stir-fry the chicken to 165°F, add the broccoli, peppers, ginger, soy sauce and scallions, then top with sesame seeds, with minutes on each step.
- Beef Street Tacos (`r-tacos`) — class 2 · Beef Street Tacos · ingredient "1 lb ground beef": "1 lb ground beef" — The dish has eight ingredients but no steps, so none are used and the cook has no instructions to follow (no browning, no 160°F doneness check, no tortilla warming, no assembly). **Fix:** Add steps: brown the beef to 160°F, warm the tortillas, chop the onion and cilantro, slice the avocados, and assemble with salsa verde, Cotija and lime.
- Teriyaki Tofu Bowl (`r-tofu`) — class 1 · Teriyaki Tofu Bowl · ingredient "14 oz extra-firm tofu": "14 oz extra-firm tofu" — The dish lists seven ingredients but has zero steps, so a cook has no method (rice cooking, tofu pressing/browning, assembly) and the derived total and hands-on times are null. **Fix:** Add full steps: cook brown rice (about 2 cups water, 40 min), press and pan-sear the tofu, steam the edamame, shred or slice the carrots, glaze with the teriyaki sauce, and assemble the bowls with sesame oil and seeds.