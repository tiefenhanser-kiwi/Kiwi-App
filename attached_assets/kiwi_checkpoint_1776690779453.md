# Kiwi — Development Checkpoint
**Last updated:** Prototype v3 Final  
**Purpose:** Living reference document for both parties. Use this when packaging for Replit, resuming long conversations, or making decisions that affect previously locked items.

---

## 1. Product Summary

**Name:** Kiwi (Kitchen Wizard)  
**Tagline:** Thought to Table — Streamlined Cooking for Home Chefs  
**Core promise:** You think about food. Kiwi handles the rest.  
**Positioning:** Hello Fresh without the middleman. Users choose what they want to eat, Kiwi handles planning, ingredients, and cooking guidance.

---

## 2. Locked Design Decisions

### Visual Identity
| Token | Value |
|---|---|
| Primary background | `#f4f7f0` (sage tint) |
| Card background | `#fff` |
| Header background | `#e8efe2` |
| Nav background | `#eef2e8` |
| Primary green | `#3a5235` (forest) |
| Accent terracotta | `#e07c3a` |
| Muted text | `#7a9470` |
| Border | `#d8e2d0` |
| Body font | DM Sans 400/500/600 |
| Border radius (cards) | 16px |
| Border radius (buttons) | 11–14px |

### Language / Copy Rules
| Avoid | Use instead |
|---|---|
| Delete / Trash | Compost |
| Generate | Build |
| Loading… | Kiwi is thinking… / Kiwi cooked up… |
| Save | Save to My Meals / Save to My Plans |

### Tone
Confident, helpful, smart. Never condescending. Feels like a knowledgeable friend, not a chatbot.

---

## 3. Subscription & Pricing

| Tier | Price | Key Gates |
|---|---|---|
| Free | $0 | Up to 4 saved plans, basic cooking steps, ads shown |
| Premium | $9.99/month or $100/year | Unlimited plans, grocery ordering, full cooking intelligence, ad-free |
| Trial | 30 days Premium (admin-configurable, can be set to 0) | Full Premium access |

**Compost tracking:** Free tier tracks number of deleted/composted plans — used for conversion marketing targeting.  
**Payment stack:** Stripe — Apple Pay, Google Pay, PayPal, Link, Credit/Debit card.  
**Annual discount:** $100/year (~$8.33/month, saves ~17%).

### Ad Format (Free Tier)
- Interstitial overlays on login and screen transitions
- Image and short video supported
- Sponsored meal plan cards in discovery feed (labeled "Sponsored")
- Promoted meals from creators, brands, health/wellness companies
- Ad serving is abstracted behind an interface — Premium users bypass it entirely

---

## 4. Feature Scope

### MVP — Included
- Kitchen Wizard (preferences → plan options → review)
- Tell Kiwi (free text → structured plan → recipe preview)
- Plan Review (assign days, swap, edit, view meal detail)
- Grocery list generation with ambiguous item flagging
- Grocery list checklist mode (in-store shopping)
- Online grocery ordering handoff
- Prep the Week flow (4-phase: seasonings → sauces → produce → proteins)
- Step-by-step Cook Mode with timing cues
- My Meals / My Dishes library
- Meal Builder (text input + URL import + image import)
- Browse Plans (Featured, Top Rated, Hosting, My Plans)
- Macros (dish total, meal total, daily average, weekly average)
- Breakfast/lunch preferences on plan with grocery list integration
- Auth (email, Google, Apple, Meta, SMS/OTP)
- Profile, preferences, pantry staples (optional)
- Upgrade to Premium flow
- "What should I cook right now?" flow

### MVP — Deferred / Phase 2
- Community features (likes, follows, sharing meals/plans)
- Creator profiles and SEO-optimized meal/plan pages
- Full pantry management (restock tracking, run-out predictions)
- Cooking step completion animations and polish
- Multi-phase prep flow past Phase 1 (wiring to real data)
- Notification delivery (architecture designed, execution deferred)
- Admin/ops tooling (curated plans, featured merchandising, promo management)
- Full macro editing UI
- More detailed retailer integration beyond the first 3

### Infrastructure Built With Phase 2 in Mind
- `is_public`, `like_count`, `save_count`, `use_count` fields on meals/plans (Day 1, display Phase 2)
- `creator_profile` concept on User entity
- Retailer adapter pattern supports adding new vendors without UX changes
- Subscription entitlement evaluator is a separate subsystem
- Analytics/event model captures behavioral data from Day 1

---

## 5. Screen Inventory (Prototype v3)

| Screen ID | Name | Status | Notes |
|---|---|---|---|
| `s-home` | Home | ✅ Complete | Wizard pair, What to cook now, Browse Plans, Get Groceries, Prep & Cook |
| `s-wizard` | Kitchen Wizard Setup | ✅ Complete | Stepper, toggles, chips, dietary collapse, free text |
| `s-planresults` | Plan Results | ✅ Complete | 3 expandable plan cards with meals + macros + Review CTA |
| `s-tellkiwi` | Tell Kiwi | ✅ Complete | Free text, servings, leftovers |
| `s-tellresults` | Tell Kiwi Results | ✅ Complete | Kiwi simple recipe + web alternatives per meal |
| `s-review` | Plan Review / Detail | ✅ Complete | Day strip, swap/edit/view, optimization panel, macros, breakfast/lunch inputs, Add More Meals, Prep & Cook |
| `s-grocery` | Grocery List | ✅ Complete | Add item w/ visible button, section-level adds, Extras section, staples, reviewed vs done actions |
| `s-retailer` | Retailer Select | ✅ Complete | Instacart, Whole Foods, Peapod, Walmart, Target |
| `s-plans` | Plans Library | ✅ Complete | Filter chips, sort, consolidated rows, This Week highlighted |
| `s-groceries` | Groceries Library | ✅ Complete | Saved lists, View/Get List/Order/Reuse actions |
| `s-getgroceries` | Get Groceries (from home) | ✅ Complete | This Week pre-selected, other plans below |
| `s-prepcook` | Prep & Cook Hub | ✅ Complete | By Plan/Meal/Dish toggle (dynamic), change plan, meal list |
| `s-prepweek` | Prep the Week | ✅ Complete | 4-phase flow, Phase 1 fully built, skip option |
| `s-cookmode` | Cook Mode | ✅ Complete | Step-by-step, timing cues in terracotta, screen-on toggle |
| `s-viewrecipe` | View Recipe | ✅ Complete | Full recipe with ingredients, steps, macros, Cook Now |
| `s-import-url` | Import by URL | ✅ Complete | Paste URL → simulated parse → Save/Add to Plan |
| `s-import-image` | Import from Image | ✅ Complete | Photo → simulated parse → ambiguous flag → Save/Add to Plan |
| `s-meal-builder` | Meal Builder | ✅ Complete | Editable ingredients, remove/add, source attribution, Save/Add actions |
| `s-meals` | My Meals | ✅ Complete | View Details / Cook Now / Add to Plan per meal row |
| `s-profile` | Profile | ✅ Complete | Trial countdown, account edit, preferences, pantry link, notification toggles |
| `s-editprefs` | Edit Preferences | ✅ Complete | Back → Profile (not Wizard) |
| `s-pantry` | Pantry Manager | ✅ Complete | Optional, default off, restock cadence, add/delete custom staples |
| `s-upgrade` | Upgrade to Premium | ✅ Complete | Monthly vs annual, all payment methods |
| `s-cooknow` | What Should I Cook | ✅ Complete | Free text, preference chips → results overlay |

### Overlays
| Overlay ID | Purpose | Status |
|---|---|---|
| `ov-mealdetail` | Full meal view with ingredients and steps | ✅ Has ✕ close button |
| `ov-addmeal` | Add meal entry point (text / URL / image / from library) | ✅ Routes to real screens |
| `ov-addtoplan` | Pick a plan to add a meal to | ✅ Complete |
| `ov-flagged` | Ambiguous grocery item review | ✅ Has ✕ close button |
| `ov-pantry` | Legacy — replaced by `s-pantry` screen | Deprecated |
| `ov-cooknow-results` | What to cook results (3 recipes) | ✅ Routes to View Recipe + Cook Mode |
| `ov-creditcard` | Card entry for upgrade | ✅ Has ✕ close button |
| `ov-changeplan` | Change active plan in Prep & Cook | ✅ Complete |

---

## 6. Grocery System Design

### Ambiguous Item Flagging
- Recipe ingredients with clear quantities → added automatically
- Free-text breakfast/lunch entries → parsed at grocery step
- Ambiguous items (e.g. "berries", "waffles", "yogurt") → flagged with chip selectors for user to specify
- Trigger: flagging happens when user initiates grocery list generation or order, not at text entry time

### Grocery List Structure (sections)
1. Produce
2. Meat & Seafood
3. Dairy & Eggs
4. Pantry
5. Pantry Staples (collapsed by default, user-configurable)
6. Extras & Household (snacks, cleaners, paper goods — user adds manually)

### Add Item UX
- Search bar at top with visible "Add" button that appears as text is typed
- Enter key also adds
- Suggestions show item name + predicted section (e.g. "Blueberries → Produce")
- "+" Add item link at bottom of each section for inline contextual adding
- Added items appear inline, removable with "Remove" link

### List Completion Flow (two separate states)
1. **"I've reviewed my list ✓"** — confirms list is ready before shopping. Unlocks step 2.
2. **"Mark Shopping Done ✓"** — confirms shopping is complete. Shows "Back to Meal Plan" + "Start Prep & Cook" options.

### Retailer Priority (MVP)
| Retailer | Integration Type | Status |
|---|---|---|
| Instacart | Direct API | Priority 1 |
| Whole Foods / Amazon Fresh | Playwright RPA | Priority 2 |
| Peapod / Stop & Shop | RPA or affiliate TBD | Priority 3 |
| Walmart | Affiliate / RPA | Future |
| Target | Affiliate / RPA | Future |

---

## 7. Cooking Intelligence Design

### Prep the Week — Phase Order
1. **Seasonings & dry ingredients** — optional/skippable (just salt & pepper = skip)
2. **Sauces, marinades, dressings, garnishes** — optional/skippable
3. **Produce** — always present; aggregate same vegetables across all meals, batch cut/prep, store by use
4. **Proteins** — always last; clean surface, food safety

### Cook Mode UX
- Full-screen step-by-step
- Shows: 1–2 completed steps (ghosted) → current step (highlighted, dark green) → 2–3 upcoming steps (muted)
- Advance: tap "Step done →" or swipe
- Timing-sensitive steps: terracotta background, "Do this soon" label (no alarms, no flashing)
- Timer: inline timer per step, tap to start
- Screen wake lock: toggle at bottom of screen

### Simple Recipe Logic (MVP)
- AI-generated simple recipe for stated meal
- Cross-referenced with top 1–2 web results
- Common ingredients = required; uncommon = optional
- Majority-rules on temperatures/times
- User can edit quantities and remove ingredients before saving

---

## 8. Macros Display Rules

| Context | Display |
|---|---|
| Dish detail | Total macros for that dish |
| Meal detail | Total macros for that meal (sum of dishes) |
| Plan view — day assigned | Daily total = sum of all meals on that day |
| Plan view — weekly | Weekly average = sum of all meal macros ÷ 7 |
| Plan results (browse) | Daily averages shown in expanded card |

**Not displayed:** Weekly totals (intentional — avoids alarming users with large numbers).  
**Not user-editable:** Macro values are calculated, not manually entered.

---

## 9. Auth & Account

### Signup Methods
- Email + password
- Google OAuth
- Apple Sign In
- Meta (Facebook) Sign In
- Phone / SMS OTP

### Minimum Fields Collected (all methods)
- First name
- Email (required even for phone signups — secondary step)
- Phone (optional prompt for email signups)
- Household size (feeds Wizard defaults)
- Zip code (retailer availability + geo marketing)

### Marketing Consent
- Captured explicitly at signup
- Stored per-channel (email consent separate from SMS consent)
- CAN-SPAM and TCPA compliant from Day 1

---

## 10. Pantry Staples (User Preference)

- **Completely optional** — new users are not prompted, no friction
- **Default state:** All items off / not set
- **Behavior when not set:** Common staples shown as optional in grocery lists (flagged individually)
- **Behavior when set:** Item excluded from grocery list by default, shown in collapsible "Pantry Staples" section
- **Restock cadence options:** Always stocked / Restock weekly / Restock monthly / Remind me when low
- **User can:** Add custom staples, delete any staple, toggle individual items on/off
- **Access:** Profile → Pantry Staples → Manage → `s-pantry` screen

---

## 11. Image Strategy

| Scenario | Approach |
|---|---|
| AI-generated / Wizard meals | Category-matched stock photo from Unsplash (Beta) → Getty/Shutterstock (post-Beta) |
| URL-imported meals | Open Graph image scraped from source URL |
| Image-imported meals | Original photo used directly |
| User-created meals (text entry) | Category-matched stock photo |
| No match found | "No image found" placeholder — revisit if frequency is high in testing |
| User uploads | Not supported in MVP (quality + moderation concerns) |

**Image service is abstracted** — source can be swapped without touching app code.

---

## 12. Social / Community (Phase 2 Infrastructure)

Fields present on Day 1 (data only, no display UI):
- `meals.is_public` (boolean)
- `meals.like_count`, `save_count`, `use_count`
- `meal_plans.is_public`
- `meal_plans.like_count`, `save_count`, `use_count`
- `users.creator_profile_id` (nullable)

Phase 2 will add:
- Public meal/plan pages (SEO-friendly URLs)
- Like, save, follow interactions
- Creator profiles
- Community discovery in Browse Plans

---

## 13. Technical Architecture (Summary)

### Stack
| Layer | Technology |
|---|---|
| Mobile app | React Native / Expo |
| Web app | React / Next.js |
| Backend | Node.js + TypeScript, modular monolith |
| Database | PostgreSQL |
| Cache / Queue | Redis |
| Object storage | S3-compatible |
| AI orchestration | LLM provider(s) behind abstraction layer |
| Payment | Stripe |
| Grocery automation | Playwright (RPA) for non-API retailers |

### Key Architecture Principles
- Modular monolith first — clean internal boundaries, not premature microservices
- AI never writes directly to production tables — all output schema-validated before use
- Retailer adapter layer — user-facing flow is identical regardless of backend integration type
- Entitlement evaluator is a separate subsystem — UI never infers entitlements from raw billing data
- Frontend owns: rendering, local interaction state, optimistic UI, form validation
- Backend owns: business rules, persistence, macro calculations, AI orchestration, billing, notifications

---

## 14. Open Items / To-Do Before Replit Handoff

### Design Still Needed
- [ ] Onboarding / first-run flow (post-signup, before home screen)
- [ ] Web interface layout (functional parity to mobile, plus public marketing site layer)
- [ ] Notification screens (future phase, but architecture should be ready)
- [ ] Admin / ops tooling (curated plans, featured plan management, promo codes)

### Prototype Screens Still Stubbed
- [ ] Prep the Week — Phases 2, 3, 4 (Phase 1 is complete)
- [ ] Cook Mode — full step completion flow (currently shows a static step 3 of 5)
- [ ] Edit meal sheet (inline servings + ingredient override, currently toast only)
- [ ] Grocery list — section-level add actually categorizing items (currently adds without categorization logic)

### Decisions Still Needed
- [ ] Web interface requirements (planned for after mobile is locked)
- [ ] Exact subscription feature matrix for edge cases (e.g. does free tier get Tell Kiwi? does free tier get What to Cook Now?)
- [ ] Admin-facing tooling scope for MVP (what does Replit need to build vs what can wait)

---

## 15. Replit Handoff Strategy

### Format
Not one file — a modular package of small files:
1. `README.md` — setup, environment variables, architecture overview
2. `design-tokens.js` — all colors, spacing, typography as JS constants
3. `components/` — one file per shared component (Button, Card, Chip, Toggle, etc.)
4. `screens/` — one file per screen
5. `api/` — API client stubs matching D2 contracts
6. `types/` — TypeScript interfaces matching D2 data models
7. `assets/` — image references and fallback strategy

### How We'll Write It
Each file is small enough to write completely in one shot. I write them one at a time across sessions, they accumulate. No single file should exceed ~200 lines. When ready to package, I produce a zip-ready directory listing with all files.

### What Replit Handles
- Infrastructure setup (hosting, database provisioning, environment config)
- Connecting frontend to backend APIs
- Deployment pipeline
- Retailer integration execution (using adapter pattern we've defined)
