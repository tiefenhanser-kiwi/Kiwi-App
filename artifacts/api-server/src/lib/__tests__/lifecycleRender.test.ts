// LIFE-1 — the template, the copy file, the tokens mirror and the unsubscribe
// token.
//
//   • every kind renders: subject, HTML and text, no placeholder left behind;
//   • the copy file is the ONE place words live: editing it changes the email;
//   • the welcome has no unsubscribe link and every other email has one;
//   • {firstName} is escaped (it is the user's own text);
//   • brand.ts matches artifacts/kiwi/constants/tokens.ts, value for value;
//   • the unsubscribe token verifies, and a tampered or foreign one does not.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EMAIL_COLORS, EMAIL_FONTS, EMAIL_LOGO_URL, EMAIL_RADIUS_PX } from "../lifecycle/brand";
import { APP_URL, FOOTER, LIFECYCLE_COPY } from "../lifecycle/copy";
import { renderLifecycleEmail } from "../lifecycle/render";
import { LIFECYCLE_KINDS } from "../lifecycle/schedule";
import {
  makeUnsubscribeToken,
  unsubscribeUrls,
  verifyUnsubscribeToken,
} from "../lifecycle/unsubscribe";

const UNSUB = "https://api.example.test/email/unsubscribe?token=abc";

function render(kind: (typeof LIFECYCLE_KINDS)[number], firstName: string | null = "Ana") {
  return renderLifecycleEmail({
    kind,
    firstName,
    endDate: "Monday, November 2",
    unsubscribeUrl: kind === "welcome" ? null : UNSUB,
  });
}

describe("LIFE-1 render — all six", () => {
  for (const kind of LIFECYCLE_KINDS) {
    it(`${kind}: subject, HTML and text, with no {placeholder} left`, () => {
      const r = render(kind);
      assert.ok(r.subject.length > 0);
      for (const part of [r.subject, r.html, r.text]) {
        assert.doesNotMatch(part, /\{(firstName|endDate)\}/);
        assert.doesNotMatch(part, /\*\*/, "bold markers are converted, never shown");
      }
      assert.match(r.html, /^<!doctype html>/);
      assert.match(r.html, /Hi Ana,/);
      assert.match(r.text, /^Hi Ana,/);
      // One button, to the web app.
      const buttons = r.html.match(/class="kiwi-btn"/g) ?? [];
      assert.equal(buttons.length, 1);
      assert.ok(r.html.includes(`href="${LIFECYCLE_COPY[kind].button.url}"`));
      assert.ok(r.text.includes(`${LIFECYCLE_COPY[kind].button.label}: ${LIFECYCLE_COPY[kind].button.url}`));
      // The footer: why, the company, the mailing address.
      for (const part of [r.html, r.text]) {
        assert.ok(part.includes(FOOTER.company));
        assert.ok(part.includes(FOOTER.mailingAddress.replace(/&/g, "&amp;")) || part.includes(FOOTER.mailingAddress));
      }
      // The logo is the public PNG, with alt text.
      assert.ok(r.html.includes(`<img src="${EMAIL_LOGO_URL}"`));
      assert.match(r.html, /alt="Kiwi"/);
    });
  }

  it("🔴 the welcome carries NO unsubscribe link; the other five each carry one, in both parts", () => {
    const w = render("welcome");
    assert.ok(!w.html.includes(FOOTER.unsubscribeLabel));
    assert.ok(!w.text.includes(FOOTER.unsubscribeLabel));
    for (const kind of LIFECYCLE_KINDS.filter((k) => k !== "welcome")) {
      const r = render(kind);
      assert.ok(r.html.includes(`href="${UNSUB}"`), `${kind} html link`);
      assert.ok(r.text.includes(`${FOOTER.unsubscribeLabel}: ${UNSUB}`), `${kind} text link`);
    }
  });

  it("{endDate} lands in the free-time subject and body", () => {
    const r = render("trial_ending");
    assert.equal(r.subject, "Your free Kiwi access ends Monday, November 2.");
    assert.match(r.html, /ends on Monday, November 2\./);
  });

  it("no first name → 'Hi there,'", () => {
    assert.match(render("day3", "  ").html, /Hi there,/);
    assert.match(render("day3", null).text, /^Hi there,/);
  });

  it("🔴 the first name is escaped — it is the member's own text", () => {
    const r = render("day1", `<script>x</script>"&`);
    assert.ok(!r.html.includes("<script>x</script>"));
    assert.ok(r.html.includes("&lt;script&gt;x&lt;/script&gt;&quot;&amp;"));
  });

  it("**bold** in the copy is <strong> in HTML and plain words in text", () => {
    const r = render("welcome");
    assert.match(r.html, /<strong[^>]*>Pick what to eat\.<\/strong>/);
    assert.match(r.text, /^Pick what to eat\. Please take the time/m);
  });

  it("email-safe: table layout, 560 px cap, dark-mode block, color-scheme meta, nothing external but the logo", () => {
    const r = render("day5");
    assert.match(r.html, /role="presentation"/);
    assert.match(r.html, /max-width:560px/);
    assert.match(r.html, /@media \(prefers-color-scheme: dark\)/);
    assert.match(r.html, /<meta name="color-scheme" content="light dark">/);
    assert.doesNotMatch(r.html, /<link\b|@import|@font-face|<script\b/i);
    const external = [...r.html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(external, [EMAIL_LOGO_URL]);
  });

  it("every button and the logo link go to the web app", () => {
    for (const kind of LIFECYCLE_KINDS) assert.equal(LIFECYCLE_COPY[kind].button.url, APP_URL);
    assert.equal(APP_URL, "https://app.kitchenwizard.ai");
  });
});

describe("LIFE-1 — the copy file is the one place words live", () => {
  it("🔴 changing a subject, a paragraph and a button label in copy.ts changes the email", () => {
    const c = LIFECYCLE_COPY.day3 as { subject: string; body: string[]; button: { label: string; url: string } };
    const saved = { subject: c.subject, body: [...c.body], label: c.button.label };
    try {
      c.subject = "EDITED SUBJECT";
      c.body = ["EDITED PARAGRAPH for {firstName}."];
      c.button.label = "EDITED BUTTON";
      const r = render("day3");
      assert.equal(r.subject, "EDITED SUBJECT");
      assert.match(r.html, /EDITED PARAGRAPH for Ana\./);
      assert.match(r.text, /EDITED BUTTON: /);
      assert.match(r.html, />EDITED BUTTON<\/a>/);
    } finally {
      c.subject = saved.subject;
      c.body = saved.body;
      c.button.label = saved.label;
    }
  });

  it("render.ts carries no email words of its own", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, "..", "lifecycle", "render.ts"), "utf8");
    for (const phrase of ["Plan my week", "Hi ", "grocery", "Unsubscribe", "Kitchen Wizard", "free access"]) {
      assert.ok(!src.includes(phrase), `render.ts contains "${phrase}"`);
    }
  });

  it("the §3 copy is verbatim — spot checks on each email", () => {
    assert.equal(LIFECYCLE_COPY.welcome.subject, "Welcome to Kiwi. Let's plan your week.");
    assert.equal(LIFECYCLE_COPY.day1.subject, "Your week isn't planned yet. It takes about 2 minutes.");
    assert.equal(LIFECYCLE_COPY.day3.subject, "One list. Everything you need.");
    assert.equal(LIFECYCLE_COPY.day5.subject, "Prep once, cook faster all week.");
    assert.equal(LIFECYCLE_COPY.trial_ending.subject, "Your free Kiwi access ends {endDate}.");
    assert.equal(LIFECYCLE_COPY.trial_ended.subject, "Your Kiwi free access has ended.");
    assert.equal(LIFECYCLE_COPY.trial_ending.button.label, "Keep my plans going");
    assert.equal(LIFECYCLE_COPY.trial_ended.button.label, "Subscribe to Kiwi");
    assert.match(LIFECYCLE_COPY.trial_ending.body[0]!, /\$9\.99 a month or \$99\.99 a year/);
  });

  // FIX-5 — Hans's rewrite of emails 1–4, verbatim, rendered. Literals here,
  // not the copy constants, so an edit to copy.ts has to be an edit here too.
  it("FIX-5: emails 1–4 render Hans's rewrite, word for word", () => {
    const welcome = render("welcome").text;
    for (const p of [
      "Thanks for giving Kiwi a try! I'm Hans, and I built Kiwi because getting dinner on the table every night was taking more of my week than it should.",
      "A few notes to help you get started fast:",
      "Pick what to eat. Please take the time to set your preferences so Kiwi knows what you like or don't. From there, Kiwi will present you with plan options or a list of meals you'll enjoy.",
      "Shop easy. Kiwi turns any set of meals and dishes into an organized and accurate grocery list. Take it to the store, or send it to Instacart.",
      "Prep ahead. Kiwi's Prep & Cook engine streamlines your time in the kitchen so weeknights go faster.",
      "If anything feels off or confusing, just reply. This comes straight to me.",
    ]) {
      assert.ok(welcome.includes(p), `welcome is missing: ${p}`);
    }
    // The "&" survives the HTML part escaped, not dropped.
    assert.ok(render("welcome").html.includes("Kiwi&#39;s Prep &amp; Cook engine"));
    assert.ok(!welcome.includes("Here's the fastest way in"));

    assert.ok(
      render("day1").text.includes(
        "In the Kiwi app, everything starts with a plan. But it doesn't have to be hard and it can be anything you like to eat. Click to get plans from your preferences, Tell Kiwi exactly what you want, or easily create your own Playlist to bring in your favorites. You can also import meals from images, websites, and just about anything else. Once the meals are in a plan, Kiwi makes the rest easy.",
      ),
    );
    assert.ok(
      render("day3").text.includes(
        "As you get familiar with Kiwi, be sure to save time and headaches with our Grocery Lists. Just add whatever you want to eat to a plan and open your grocery list. Kiwi reviews and consolidates every ingredient for you and sorts it by aisle, so you're not buying three onions twice. Or two when you needed three! Check things off as you shop, or send the whole list to Instacart.",
      ),
    );
    assert.ok(
      render("day5").text.includes(
        "Kiwi's patent-pending Prep & Cook engine can make cooking easier even if you don't have time to spare every Sunday. Cook easier with our guided cooking steps that make cooking simpler while ensuring your dishes finish together. Or prep a selected meal in the morning to make the evening stress free. Ready to really thank yourself? Use Prep the Week and Kiwi groups the chopping, marinades and sauces for every meal into one session, so each weeknight is more about eating than cooking.",
      ),
    );
    // One paragraph each, and the buttons kept.
    for (const kind of ["day1", "day3", "day5"] as const) assert.equal(LIFECYCLE_COPY[kind].body.length, 1);
    assert.equal(LIFECYCLE_COPY.welcome.body.length, 5);
    assert.equal(LIFECYCLE_COPY.welcome.button.label, "Plan my week");
    assert.equal(LIFECYCLE_COPY.day1.button.label, "Plan my week");
    assert.equal(LIFECYCLE_COPY.day3.button.label, "Open my grocery list");
    assert.equal(LIFECYCLE_COPY.day5.button.label, "Try Prep the Week");
  });
});

describe("LIFE-1 — brand.ts mirrors artifacts/kiwi/constants/tokens.ts", () => {
  it("🔴 every mirrored colour, font family and the radius equal the app's tokens", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tokensPath = path.join(here, "..", "..", "..", "..", "kiwi", "constants", "tokens.ts");
    const mod = (await import(pathToFileURL(tokensPath).href)) as {
      Colors: Record<string, Record<string, string>>;
      Palette: { background: Record<string, string>; button: { sage: { background: string; text: string } } };
      Typography: { fontFamily: { sans: string; serif: string } };
      Radius: { lg: number };
    };
    const { Colors, Palette, Typography, Radius } = mod;
    const pairs: Array<[string, string, string]> = [
      ["page", EMAIL_COLORS.page, Palette.background.app!],
      ["card", EMAIL_COLORS.card, Palette.background.card!],
      ["cardBorder", EMAIL_COLORS.cardBorder, Colors.neutral![300]!],
      ["ink", EMAIL_COLORS.ink, Colors.neutral![900]!],
      ["body", EMAIL_COLORS.body, Colors.neutral![800]!],
      ["muted", EMAIL_COLORS.muted, Colors.neutral![700]!],
      ["button", EMAIL_COLORS.button, Palette.button.sage.background],
      ["buttonText", EMAIL_COLORS.buttonText, Palette.button.sage.text],
      ["darkPage", EMAIL_COLORS.darkPage, Colors.sage![900]!],
      ["darkCard", EMAIL_COLORS.darkCard, Colors.sage![800]!],
      ["darkCardBorder", EMAIL_COLORS.darkCardBorder, Colors.sage![700]!],
      ["darkInk", EMAIL_COLORS.darkInk, Colors.neutral![100]!],
      ["darkBody", EMAIL_COLORS.darkBody, Colors.neutral![200]!],
      ["darkMuted", EMAIL_COLORS.darkMuted, Colors.neutral![400]!],
    ];
    for (const [name, mine, theirs] of pairs) {
      assert.equal(mine.toLowerCase(), theirs.toLowerCase(), `EMAIL_COLORS.${name}`);
    }
    assert.ok(EMAIL_FONTS.serif.startsWith(Typography.fontFamily.serif));
    assert.ok(EMAIL_FONTS.sans.startsWith(`'${Typography.fontFamily.sans}'`));
    assert.equal(EMAIL_RADIUS_PX, Radius.lg);
  });
});

describe("LIFE-1 — the unsubscribe token", () => {
  const env = { JWT_SECRET: "test-secret-one", PUBLIC_APP_URL: "https://api.example.test/" };
  const USER = "6f1c2f4e-0000-4000-8000-000000000001";

  it("round-trips to the userId it was signed for", () => {
    const t = makeUnsubscribeToken(USER, env)!;
    assert.equal(verifyUnsubscribeToken(t, env), USER);
  });

  it("🔴 a tampered userId, a tampered signature, another key or junk → null", () => {
    const t = makeUnsubscribeToken(USER, env)!;
    const other = "6f1c2f4e-0000-4000-8000-000000000002";
    assert.equal(verifyUnsubscribeToken(t.replace(USER, other), env), null);
    assert.equal(verifyUnsubscribeToken(t.slice(0, -2) + "AA", env), null);
    assert.equal(verifyUnsubscribeToken(t, { JWT_SECRET: "another-secret" }), null);
    for (const junk of ["", ".", "abc", `${USER}.`, null, 42, "x".repeat(500)]) {
      assert.equal(verifyUnsubscribeToken(junk, env), null);
    }
  });

  it("is not the session signature: a token signed for one purpose is not the other", () => {
    // The key is derived under its own label, so even the raw HMAC of the
    // userId under JWT_SECRET (what a careless implementation would use) fails.
    const naive = `${USER}.${createHmac("sha256", env.JWT_SECRET).update(USER).digest("base64url")}`;
    assert.equal(verifyUnsubscribeToken(naive, env), null);
  });

  it("no JWT_SECRET → no token and no URLs (the runner then refuses to send)", () => {
    assert.equal(makeUnsubscribeToken(USER, {}), null);
    assert.equal(unsubscribeUrls(USER, { PUBLIC_APP_URL: "https://x.test" }), null);
    assert.equal(unsubscribeUrls(USER, { JWT_SECRET: "s" }), null);
  });

  it("the page link and the RFC 8058 POST target, on PUBLIC_APP_URL", () => {
    const u = unsubscribeUrls(USER, env)!;
    assert.match(u.page, /^https:\/\/api\.example\.test\/email\/unsubscribe\?token=/);
    assert.match(u.post, /^https:\/\/api\.example\.test\/api\/email\/unsubscribe\?token=/);
  });
});
