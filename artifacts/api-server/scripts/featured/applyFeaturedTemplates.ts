// THX-1 — put the five everyday plans on the Featured rail and retire the
// dev-plan-template-* seeds, in ONE transaction.
//
// Run from artifacts/api-server. A bare run is a DRY RUN: it prints the
// database hostname, every row it would create, update or archive, and every
// check, and writes nothing. Only `--apply` writes.
//
//   # dev (the DATABASE_URL host contains ep-broad-haze)
//   node --env-file=.env --import tsx scripts/featured/applyFeaturedTemplates.ts
//   node --env-file=.env --import tsx scripts/featured/applyFeaturedTemplates.ts --apply
//
//   # PRODUCTION — exactly as the R3-0 runbook scripts run
//   # (scripts/grocery-release/README.md §1): the production DATABASE_URL in a
//   # separate env file, and KIWI_PRODUCTION_HOST typed into the shell for the
//   # run — the EXACT production hostname. Never in .env; unset it afterwards.
//   $env:KIWI_PRODUCTION_HOST = "<the production hostname>"
//   node --env-file=<prod-env> --import tsx scripts/featured/applyFeaturedTemplates.ts --dry-run
//   node --env-file=<prod-env> --import tsx scripts/featured/applyFeaturedTemplates.ts --apply
//   Remove-Item Env:KIWI_PRODUCTION_HOST
//
// A production run prints "PRODUCTION host … (KIWI_PRODUCTION_HOST matched)"
// to stderr first; without that line you are not on production.
//
// What it writes (featured-plans.json is the spec):
//   - the editorial owner "Kiwi Kitchen" (featuredCore.ts OWNER explains every
//     field), created if missing;
//   - MealPlanTemplate `featured-<slug>` per plan: public, featured, not
//     hosting-featured, railPosition 1..N in spec order, no featuring window,
//     defaultDaysCount 5, imageUrl copied from the cover meal;
//   - its items, replaced: five Monday–Friday dinner items;
//   - stampAllergens for every meal (D-WS9-211: after every public-pool write);
//   - the PUBLIC dev-plan-template-* seeds retired (archived, off the rail,
//     both featuring flags off). A private seed row is listed and left alone.
//
// It aborts, writing nothing, on any spec error or any failed meal check
// (featuredCore.ts validateSpec / checkMeals), and lists every failure.
//
// IDEMPOTENT: a second dry run after an apply reports zero changes.
// Undo: revertFeaturedTemplates.ts (takes featured-* off the rail; the seeds
// stay retired).
//
// THX-2S (D-WS9-311) — the Thanksgiving fields, all optional (an everyday spec
// writes exactly what it wrote before):
//   - per plan: `anchorDate` ("YYYY-MM-DD" → MealPlanTemplate.anchorDate) and
//     the featuring window `featuredFrom` / `featuredUntil` (zoned ISO
//     instants → featuredStartDate / featuredEndDate); a dated plan must name a
//     featuredUntil no later than the end of its anchor day (UTC−10);
//   - per day: `servingsOverride` (→ MealPlanTemplateItem.servingsOverride) and
//     `thx2Key` in place of `mealId` (resolved like scripts/thx2/: the
//     batch_generated meal whose dishFamilyKey is the key);
//   - per plan (CLIENT-2 E1, BUG-512): `featured` (default true → isFeatured
//     and a railPosition; false → neither, off the Featured chip AND the Home
//     rail) and `hosting` (default false → isHostingFeatured, the Hosting &
//     events chip; true needs featuredFrom and featuredUntil);
//   - `--spec <path>` reads another spec file (default featured-plans.json).
//     ⚠️ railPosition is the plan's index in ITS spec: put the Thanksgiving
//     plans and the everyday five in ONE spec (Thanksgiving 1–5, everyday
//     6–10), or the two files' positions collide.
//
// CLIENT-2b C (BUG-512) — dumpFeaturedSpec.ts prints the spec that reproduces
// a database's featured-* templates (read-only); a dry run of this script on
// its output reports ZERO CHANGES when the dump is faithful.

import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PrismaClient, type Prisma } from "@prisma/client";

import { deriveAllergensForMeal, stampAllergens } from "../../src/lib/allergens";
import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import {
  OWNER,
  RETIRED_SEED,
  SEED_ID_PREFIX,
  checkMeals,
  coverMealIdFor,
  desiredItems,
  desiredTemplate,
  fieldChanges,
  resolveThx2Keys,
  sameItems,
  templateIdFor,
  thx2KeysOf,
  validateSpec,
  validateThanksgivingFields,
  type ItemFields,
  type Spec,
  type TemplateFields,
} from "./featuredCore";

const HERE = dirname(fileURLToPath(import.meta.url));
const say = (s = "") => console.log(s);

const SEED_SELECT = {
  id: true,
  title: true,
  isPublic: true,
  isArchived: true,
  isFeatured: true,
  isHostingFeatured: true,
  railPosition: true,
  featuredStartDate: true,
  featuredEndDate: true,
} as const;

/** Sorted keys, sorted values — the shape stampAllergens compares against. */
function canonicalSources(v: unknown): string {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return "null";
  const o = v as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(o)
      .sort()
      .map((k) => [k, Array.isArray(o[k]) ? (o[k] as unknown[]).map(String).sort() : []]),
  );
}

async function main(): Promise<void> {
  const { host, mode } = assertScriptDatabase("featured/applyFeaturedTemplates");
  const APPLY = process.argv.includes("--apply");
  const prisma = new PrismaClient();
  try {
    say(`[thx-1] featured templates — ${APPLY ? "APPLY (writing, one transaction)" : "DRY RUN (writes nothing)"}`);
    say(`database host: ${host} (${mode})`);
    say();

    // ── 1. the spec ───────────────────────────────────────────────────────
    const specArg = process.argv.indexOf("--spec");
    const specPath =
      specArg >= 0 && process.argv[specArg + 1]
        ? resolvePath(process.argv[specArg + 1])
        : join(HERE, "featured-plans.json");
    say(`spec file: ${specPath}`);
    const rawSpec = JSON.parse(readFileSync(specPath, "utf8")) as Spec;

    // THX-2S — the Thanksgiving fields first, then every thx2Key resolved to
    // its meal id, so the THX-1 checks below see ordinary mealIds.
    const thxErrors = validateThanksgivingFields(rawSpec);
    const keys = Array.isArray(rawSpec.plans) ? thx2KeysOf(rawSpec) : [];
    const keyed = keys.length
      ? await prisma.meal.findMany({
          where: { sourceType: "batch_generated", dishFamilyKey: { in: keys } },
          select: { id: true, dishFamilyKey: true },
        })
      : [];
    const idByKey = new Map(keyed.map((m) => [m.dishFamilyKey as string, m.id]));
    const resolved = thxErrors.length ? { spec: rawSpec, errors: [] } : resolveThx2Keys(rawSpec, idByKey);
    const spec = resolved.spec;
    say(`check: Thanksgiving fields — ${keys.length} thx2 key(s), ${idByKey.size} resolved; ${thxErrors.length + resolved.errors.length ? `${thxErrors.length + resolved.errors.length} error(s)` : "valid"}`);
    for (const k of keys) say(`  ${k} -> ${idByKey.get(k) ?? "(not on this database)"}`);
    if (thxErrors.length || resolved.errors.length) {
      for (const e of [...thxErrors, ...resolved.errors]) say(`  ✗ ${e}`);
      say("\nABORT: the spec's Thanksgiving fields are invalid. Nothing was written.");
      process.exitCode = 1;
      return;
    }
    const specErrors = validateSpec(spec);
    say(`check: spec — ${spec.plans?.length ?? 0} plans, ${specErrors.length ? `${specErrors.length} error(s)` : "valid (titles ≤ 42, five Mon–Fri days, no meal in two plans)"}`);
    if (specErrors.length) {
      for (const e of specErrors) say(`  ✗ ${e}`);
      say("\nABORT: the spec is invalid. Nothing was written.");
      process.exitCode = 1;
      return;
    }

    // ── 2. the meals ──────────────────────────────────────────────────────
    const mealIds = [...new Set(spec.plans.flatMap((p) => p.days.map((d) => d.mealId)))];
    const meals = await prisma.meal.findMany({
      where: { id: { in: mealIds } },
      select: {
        id: true, title: true, cuisineType: true, isPublic: true, isArchived: true,
        imageUrl: true, activeTimeMinutes: true, estimatedTimeMinutes: true, userId: true,
        caloriesPerServing: true, allergens: true, allergenSources: true, allergensStampedAt: true,
      },
    });
    const mealFailures = checkMeals(spec, meals);
    say(`check: meals — ${mealIds.length} named, ${meals.length} found; exist/public/not archived/image/activeTimeMinutes/catalog-owned/≤2 per cuisine: ${mealFailures.length ? `${mealFailures.length} failure(s)` : "all pass"}`);
    if (mealFailures.length) {
      for (const f of mealFailures) say(`  ✗ ${f}`);
      say("\nABORT: a meal check failed. Nothing was written.");
      process.exitCode = 1;
      return;
    }
    const mealById = new Map(meals.map((m) => [m.id, m]));

    // ── 3. the owner ──────────────────────────────────────────────────────
    const ownerById = await prisma.user.findUnique({
      where: { id: OWNER.id },
      select: { id: true, email: true, firstName: true, lastName: true, accountStatus: true, subscriptionStatus: true, signupSource: true, passwordHash: true },
    });
    const ownerByEmail = await prisma.user.findUnique({ where: { email: OWNER.email }, select: { id: true } });
    if (ownerByEmail && ownerByEmail.id !== OWNER.id) {
      say(`  ✗ ${OWNER.email} already belongs to user ${ownerByEmail.id} — refusing to adopt a real account`);
      say("\nABORT: owner email taken. Nothing was written.");
      process.exitCode = 1;
      return;
    }
    const identities = ownerById ? await prisma.userIdentity.count({ where: { userId: OWNER.id } }) : 0;
    const subscription = ownerById ? await prisma.subscription.count({ where: { userId: OWNER.id } }) : 0;
    const ownerWant = {
      email: OWNER.email,
      firstName: OWNER.firstName,
      lastName: OWNER.lastName,
      accountStatus: OWNER.accountStatus,
      subscriptionStatus: OWNER.subscriptionStatus,
      signupSource: OWNER.signupSource,
      passwordHash: null,
    };
    const ownerChanges = fieldChanges(ownerById, ownerWant);
    say();
    say(`OWNER ${OWNER.id} <${OWNER.email}>`);
    if (!ownerById) say("  CREATE  " + fieldChanges(null, ownerWant).join("; "));
    else if (ownerChanges.length) say("  UPDATE  " + ownerChanges.join("; "));
    else say("  unchanged");
    say(`  check: ${identities} OAuth identit${identities === 1 ? "y" : "ies"}, ${subscription} subscription row(s) (expect 0 and 0)`);
    if (identities || subscription) {
      say("\nABORT: the editorial owner has an identity or a subscription — someone can sign in as it. Nothing was written.");
      process.exitCode = 1;
      return;
    }

    // ── 4. the featured templates ─────────────────────────────────────────
    const ids = spec.plans.map((p) => templateIdFor(p.slug));
    const existing = await prisma.mealPlanTemplate.findMany({
      where: { id: { in: ids } },
      include: { items: true },
    });
    const existingById = new Map(existing.map((t) => [t.id, t]));
    interface TemplatePlan { id: string; want: TemplateFields; items: ItemFields[]; create: boolean; changes: string[]; replaceItems: boolean }
    const templatePlans: TemplatePlan[] = spec.plans.map((p, i) => {
      const id = templateIdFor(p.slug);
      const cover = mealById.get(coverMealIdFor(p))!;
      const want = desiredTemplate(p, i, cover.imageUrl);
      const items = desiredItems(p);
      const have = existingById.get(id) ?? null;
      return {
        id,
        want,
        items,
        create: !have,
        changes: have ? fieldChanges(have, want) : [],
        replaceItems: !have || !sameItems(have.items, items),
      };
    });
    for (const [i, tp] of templatePlans.entries()) {
      const p = spec.plans[i];
      const cover = mealById.get(coverMealIdFor(p))!;
      say();
      say(`TEMPLATE ${tp.id} — "${tp.want.title}" (rail ${tp.want.railPosition}, cover "${cover.title}")`);
      if (tp.create) say(`  CREATE  ${fieldChanges(null, tp.want).join("; ")}`);
      else if (tp.changes.length) say(`  UPDATE  ${tp.changes.join("; ")}`);
      else say("  row unchanged");
      if (tp.want.anchorDate || tp.want.featuredStartDate || tp.want.featuredEndDate) {
        say(`  anchor ${tp.want.anchorDate?.toISOString().slice(0, 10) ?? "none"} · featured ${tp.want.featuredStartDate?.toISOString() ?? "open"} .. ${tp.want.featuredEndDate?.toISOString() ?? "open"}`);
      }
      say(`  items: ${tp.replaceItems ? "REPLACE with" : "unchanged —"}`);
      for (const it of tp.items) {
        const m = mealById.get(it.mealId)!;
        const servings = it.servingsOverride != null ? `  ×${it.servingsOverride} servings` : "";
        say(`    ${it.assignedDayOfWeek?.padEnd(9)} dinner  ${m.id}  ${m.title}  [${m.cuisineType ?? "?"} · ${m.estimatedTimeMinutes} min · ${Math.round(m.caloriesPerServing)} kcal]${servings}`);
      }
    }

    // ── 5. the seeds ──────────────────────────────────────────────────────
    const seeds = await prisma.mealPlanTemplate.findMany({
      where: { id: { startsWith: SEED_ID_PREFIX } },
      select: SEED_SELECT,
      orderBy: { id: "asc" },
    });
    const retire = seeds.filter(
      (s) => s.isPublic && fieldChanges(s, RETIRED_SEED).length > 0,
    );
    say();
    say(`SEEDS matching ${SEED_ID_PREFIX}% — ${seeds.length} row(s); values BEFORE this run, for the record:`);
    if (!seeds.length) say("  (none on this database)");
    for (const s of seeds) {
      const verdict = !s.isPublic
        ? "private — left alone"
        : retire.includes(s)
          ? `RETIRE  ${fieldChanges(s, RETIRED_SEED).join("; ")}`
          : "already retired";
      say(`  ${s.id}  "${s.title}"  public=${s.isPublic} archived=${s.isArchived} featured=${s.isFeatured} hosting=${s.isHostingFeatured} rail=${s.railPosition} window=${s.featuredStartDate?.toISOString() ?? "null"}..${s.featuredEndDate?.toISOString() ?? "null"}`);
      say(`    -> ${verdict}`);
    }

    // ── 6. anything else on the rail ──────────────────────────────────────
    const others = await prisma.mealPlanTemplate.findMany({
      where: {
        railPosition: { not: null },
        isPublic: true,
        isArchived: false,
        id: { notIn: ids },
        NOT: { id: { startsWith: SEED_ID_PREFIX } },
      },
      select: { id: true, title: true, railPosition: true },
    });
    say();
    say(`check: other rail rows (not featured-*, not seeds) — ${others.length ? others.map((o) => `${o.id} "${o.title}" rail=${o.railPosition}`).join("; ") + " — left alone, they will interleave" : "none"}`);

    // ── 7. allergen stamps ────────────────────────────────────────────────
    const restamp: string[] = [];
    for (const id of mealIds) {
      const m = mealById.get(id)!;
      const d = await deriveAllergensForMeal(prisma, id);
      if (!d) continue;
      const tokensSame = [...m.allergens].sort().join(",") === d.tokens.join(",");
      const sourcesSame = canonicalSources(m.allergenSources) === canonicalSources(d.sources);
      if (!tokensSame || !sourcesSame || m.allergensStampedAt == null) {
        const what = !tokensSame
          ? `TOKENS [${m.allergens.join(",")}] -> [${d.tokens.join(",")}]`
          : m.allergensStampedAt == null
            ? `[${d.tokens.join(",")}] never stamped`
            : `tokens unchanged [${d.tokens.join(",")}]; allergenSources names differ (e.g. ingredient display-name casing)`;
        restamp.push(`${id} "${m.title}": ${what}`);
      }
    }
    say(`check: allergen stamps — ${mealIds.length} meals derived from their ingredient graph; ${restamp.length ? `${restamp.length} would change:` : "all current (stampAllergens will be a no-op)"}`);
    for (const r of restamp) say(`  RESTAMP ${r}`);

    // ── summary ───────────────────────────────────────────────────────────
    const creates = (ownerById ? 0 : 1) + templatePlans.filter((t) => t.create).length;
    const updates =
      (ownerById && ownerChanges.length ? 1 : 0) +
      templatePlans.filter((t) => !t.create && t.changes.length).length;
    const itemSets = templatePlans.filter((t) => t.replaceItems).length;
    const total = creates + updates + itemSets + retire.length + restamp.length;
    say();
    say(`SUMMARY: ${creates} create, ${updates} update, ${itemSets} item set(s) replaced, ${retire.length} seed(s) archived, ${restamp.length} allergen restamp(s) — ${total === 0 ? "ZERO CHANGES" : `${total} change(s)`}`);

    if (!APPLY) {
      say("DRY RUN — nothing was written. Re-run with --apply to write.");
      return;
    }
    if (total === 0) {
      say("Nothing to write.");
      return;
    }

    // ── the one transaction ───────────────────────────────────────────────
    await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        if (!ownerById) {
          await tx.user.create({ data: { id: OWNER.id, ...ownerWant } });
        } else if (ownerChanges.length) {
          await tx.user.update({ where: { id: OWNER.id }, data: ownerWant });
        }
        for (const tp of templatePlans) {
          if (tp.create) {
            await tx.mealPlanTemplate.create({ data: { id: tp.id, ...tp.want } });
          } else if (tp.changes.length) {
            await tx.mealPlanTemplate.update({ where: { id: tp.id }, data: tp.want });
          }
          if (tp.replaceItems) {
            await tx.mealPlanTemplateItem.deleteMany({ where: { mealPlanTemplateId: tp.id } });
            await tx.mealPlanTemplateItem.createMany({
              data: tp.items.map((it) => ({ mealPlanTemplateId: tp.id, ...it })),
            });
          }
        }
        if (retire.length) {
          await tx.mealPlanTemplate.updateMany({
            where: { id: { in: retire.map((s) => s.id) }, isPublic: true },
            data: RETIRED_SEED,
          });
        }
        // D-WS9-211 — every meal on a public template, after the write. A
        // no-op (no UPDATE) for a meal whose stamp is already current.
        for (const id of mealIds) await stampAllergens(tx, id);
      },
      { maxWait: 20_000, timeout: 120_000 },
    );
    say(`APPLIED on ${host}: ${total} change(s) committed in one transaction.`);
  } finally {
    await prisma.$disconnect();
  }
}

// Exact entry-point check: importing this module must never run it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
