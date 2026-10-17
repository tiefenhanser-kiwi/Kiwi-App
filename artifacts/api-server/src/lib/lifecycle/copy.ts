// LIFE-1 — EVERY WORD OF THE SIX LIFECYCLE EMAILS, AND NOTHING ELSE.
//
// ✏️ THIS IS THE FILE TO EDIT. Changing a subject, a paragraph, a button label
// or a footer line is an edit here and nowhere else; render.ts and the
// scheduler read this file and never carry text of their own.
//
// How to write in it:
//   • Each string in `body` / `after` is one paragraph. Add, remove or reorder
//     them freely.
//   • {firstName} becomes the account's first name ("there" when it has none).
//     {endDate} becomes the free-time end date, e.g. "Monday, November 2".
//     {endDate} only means something in the two free-time emails.
//   • **like this** makes words bold. That is the only markup.
//   • `greeting` is the first line, set larger in Kiwi's serif.
//   • `button.url` is where the one button goes.
//
// After an edit, re-render the previews and read them:
//   cd artifacts/api-server
//   node --import tsx scripts/lifecycle/previewEmails.ts
//
// When each email is SENT is not here: it is lib/lifecycle/schedule.ts.

/** Where every button and the logo link go: the web app, which handles sign-in. */
export const APP_URL = "https://app.kitchenwizard.ai";

/** Where replies go. Every lifecycle email sets it as Reply-To. */
export const REPLY_TO = "support@kitchenwizard.ai";

/** The small line under every button. */
export const APPS_NOTE =
  "The button opens Kiwi on the web. The Kiwi app on your phone works too, with the same sign-in.";

/** The footer. */
export const FOOTER = {
  /** Why they are getting this. */
  reason: "You're getting this because you have a Kiwi account.",
  /** The unsubscribe link's words. Never on the welcome email. */
  unsubscribeLabel: "Unsubscribe from these emails",
  company: "Kitchen Wizard, Inc.",
  /**
   * ⚠️ PLACEHOLDER. CAN-SPAM requires a valid postal address in every
   * commercial email. No address exists anywhere in the app's code; Hans fills
   * this in before production sending is switched on.
   */
  mailingAddress: "[MAILING ADDRESS GOES HERE]",
} as const;

export interface EmailCopy {
  subject: string;
  greeting: string;
  /** Paragraphs above the button. */
  body: string[];
  button: { label: string; url: string };
  /** Paragraphs below the button (may be empty). */
  after: string[];
}

export const LIFECYCLE_COPY = {
  /** 1. Sent at signup. */
  welcome: {
    subject: "Welcome to Kiwi. Let's plan your week.",
    greeting: "Hi {firstName},",
    body: [
      "I'm Hans. I built Kiwi because getting dinner on the table every night was taking more of my week than it should.",
      "Here's the fastest way in:",
      "**Plan your week.** Tell Kiwi what you're in the mood for, or start from one of our featured plans.",
      "**Shop once.** Kiwi turns the week into one grocery list. Take it to the store, or send it to Instacart.",
      "**Prep ahead.** Prep the Week does all the chopping at once, so weeknights go faster.",
    ],
    button: { label: "Plan my week", url: APP_URL },
    after: [
      "If anything feels off or confusing, just reply. This comes straight to me.",
      "Hans",
    ],
  },

  /** 2. 24 hours after signup, only to an account with no plan yet. */
  day1: {
    subject: "Your week isn't planned yet. It takes about 2 minutes.",
    greeting: "Hi {firstName},",
    body: [
      "Pick a featured plan, or tell Kiwi something like \"easy dinners for four, nothing too spicy,\" and you'll have a full week in a couple of minutes. You can swap any meal you don't like.",
    ],
    button: { label: "Plan my week", url: APP_URL },
    after: [],
  },

  /** 3. 72 hours after signup. */
  day3: {
    subject: "One list. Everything you need.",
    greeting: "Hi {firstName},",
    body: [
      "Once your week is planned, open your grocery list. Kiwi adds up every recipe for you and sorts it by aisle, so you're not buying three onions twice. Check things off as you shop, or send the whole list to Instacart.",
    ],
    button: { label: "Open my grocery list", url: APP_URL },
    after: [],
  },

  /** 4. 120 hours after signup. */
  day5: {
    subject: "Prep once, cook faster all week.",
    greeting: "Hi {firstName},",
    body: [
      "Try Prep the Week. Kiwi groups the chopping, marinades and sauces for every meal into one session, so each weeknight is mostly cooking. Then Cook Mode walks you through dinner one step at a time.",
    ],
    button: { label: "Try Prep the Week", url: APP_URL },
    after: [],
  },

  /** 5. Three days before the trial or free period ends. Never to a paying subscriber. */
  trial_ending: {
    subject: "Your free Kiwi access ends {endDate}.",
    greeting: "Hi {firstName},",
    body: [
      "Your free access to Kiwi ends on {endDate}. To keep planning, it's $9.99 a month or $99.99 a year. There's no card on file, so nothing is charged unless you choose to subscribe.",
    ],
    button: { label: "Keep my plans going", url: APP_URL },
    after: [
      "If Kiwi hasn't earned it yet, I'd really like to know why. Just reply.",
    ],
  },

  /** 6. When the trial or free period has ended. Never to a paying subscriber. */
  trial_ended: {
    subject: "Your Kiwi free access has ended.",
    greeting: "Hi {firstName},",
    body: [
      "Your free access ended today. Your plans and recipes are still here when you subscribe.",
    ],
    button: { label: "Subscribe to Kiwi", url: APP_URL },
    after: [
      "Thanks for trying Kiwi. If something didn't work for you, reply and tell me. I read every one.",
    ],
  },
} satisfies Record<string, EmailCopy>;
