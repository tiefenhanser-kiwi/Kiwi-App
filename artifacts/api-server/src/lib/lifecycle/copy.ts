// LIFE-1 + LIFE-2 — EVERY WORD OF THE FOURTEEN LIFECYCLE EMAILS, AND NOTHING ELSE.
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
//     {planEndDay} becomes the weekday the plan runs out, e.g. "Friday"; it
//     only means something in next_week.
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
  mailingAddress: "P.O. Box 15, Wenham, MA 01984",
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
      "Thanks for giving Kiwi a try! I'm Hans, and I built Kiwi because getting dinner on the table every night was taking more of my week than it should.",
      "A few notes to help you get started fast:",
      "**Pick what to eat.** Please take the time to set your preferences so Kiwi knows what you like or don't. From there, Kiwi will present you with plan options or a list of meals you'll enjoy.",
      "**Shop easy.** Kiwi turns any set of meals and dishes into an organized and accurate grocery list. Take it to the store, or send it to Instacart.",
      "**Prep ahead.** Kiwi's Prep & Cook engine streamlines your time in the kitchen so weeknights go faster.",
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
      "In the Kiwi app, everything starts with a plan. But it doesn't have to be hard and it can be anything you like to eat. Click to get plans from your preferences, Tell Kiwi exactly what you want, or easily create your own Playlist to bring in your favorites. You can also import meals from images, websites, and just about anything else. Once the meals are in a plan, Kiwi makes the rest easy.",
    ],
    button: { label: "Plan my week", url: APP_URL },
    after: [],
  },

  /** 3. 72 hours after signup, only while no grocery list exists (LIFE-2). */
  day3: {
    subject: "One list. Everything you need.",
    greeting: "Hi {firstName},",
    body: [
      "As you get familiar with Kiwi, be sure to save time and headaches with our Grocery Lists. Just add whatever you want to eat to a plan and open your grocery list. Kiwi reviews and consolidates every ingredient for you and sorts it by aisle, so you're not buying three onions twice. Or two when you needed three! Check things off as you shop, or send the whole list to Instacart.",
    ],
    button: { label: "Open my grocery list", url: APP_URL },
    after: [],
  },

  /** 4. 120 hours after signup, only while no prep session has started (LIFE-2). */
  day5: {
    subject: "Prep once, cook faster all week.",
    greeting: "Hi {firstName},",
    body: [
      "Kiwi's patent-pending Prep & Cook engine can make cooking easier even if you don't have time to spare every Sunday. Cook easier with our guided cooking steps that make cooking simpler while ensuring your dishes finish together. Or prep a selected meal in the morning to make the evening stress free. Ready to really thank yourself? Use Prep the Week and Kiwi groups the chopping, marinades and sauces for every meal into one session, so each weeknight is more about eating than cooking.",
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
      "Your free access has ended. Your plans and recipes are still here when you subscribe.",
    ],
    button: { label: "Subscribe to Kiwi", url: APP_URL },
    after: [
      "Thanks for trying Kiwi. If something didn't work for you, reply and tell me. I read every one.",
    ],
  },

  // ── LIFE-2 — the eight event-driven emails ("Kiwi Lifecycle Emails", Oct 25). ──

  /** 7. 24 hours after the first plan, only while no grocery list exists. */
  list_nudge: {
    subject: "Your list is one tap away",
    greeting: "Hi {firstName},",
    body: [
      "You've got a plan — nice. The next part is the one Kiwi is best at: open the plan and tap Grocery list. Kiwi pulls every ingredient from every meal, combines them, and sorts them by aisle. Take it to the store or send it to Instacart.",
    ],
    button: { label: "Open my grocery list", url: APP_URL },
    after: [],
  },

  /** 8. A day after the first grocery list, only while no prep or cook session has started. */
  prep_nudge: {
    subject: "Shopped? Here's how the week goes",
    greeting: "Hi {firstName},",
    body: [
      "With the groceries in, you've got two ways to make the week easier. Prep the Week groups all the chopping, marinades and sauces into one session — an hour on Sunday, and every weeknight is mostly cooking, not prepping. Or skip the prep and open any meal in Cook Mode: Kiwi orders the steps so the dishes finish together.",
    ],
    button: { label: "Try Prep the Week", url: APP_URL },
    after: [],
  },

  /** 9. The morning after the first finished cook. Once. */
  first_cook: {
    subject: "How did it go?",
    greeting: "Hi {firstName},",
    body: [
      "You cooked your first Kiwi meal last night. How was it — the timing, the steps, the food? Reply to this email and tell me; it comes straight to me and it's how Kiwi gets better.",
    ],
    button: { label: "Open Kiwi", url: APP_URL },
    after: [],
  },

  /** 10. Two days before the current plan's last day, while no later plan exists. Once per plan. */
  next_week: {
    subject: "Next week's plan",
    greeting: "Hi {firstName},",
    body: [
      "Your plan runs out on {planEndDay}. Two minutes now saves the Sunday scramble: get plans from your preferences, Tell Kiwi what you're in the mood for, or pull from your Playlist.",
    ],
    button: { label: "Plan next week", url: APP_URL },
    after: [],
  },

  /** 11. When the second plan is created, only while no Playlist exists. (Hans, Oct 25 — final.) */
  playlist_nudge: {
    subject: "Build your Playlist",
    greeting: "Hi {firstName},",
    body: [
      "Two plans in — you've probably found a few meals you'd make again. Save them to your Playlist and Kiwi can build a week from your favorites in one tap, any time.",
      "Want your own favorites and go-to's? Kiwi makes it easy to import any recipe, or just describe the meals you love and Kiwi will add them for you.",
    ],
    button: { label: "Start my Playlist", url: APP_URL },
    after: [],
  },

  /** 12. When the second grocery list is created, only if no list has ever gone to Instacart. */
  instacart_nudge: {
    subject: "Skip the store this week",
    greeting: "Hi {firstName},",
    body: [
      "Your grocery list can go straight to Instacart: one tap, every item in the cart, delivered or ready for pickup. Same list, no aisles.",
    ],
    button: { label: "Send my list to Instacart", url: APP_URL },
    after: [],
  },

  /** 13. After 7 days with no activity, during the free time. */
  still_here: {
    subject: "Still here?",
    greeting: "Hi {firstName},",
    body: [
      "It's been a week since you were in Kiwi. If something got in the way — a meal that missed, a step that confused you, a list that was wrong — reply and tell me. If you just got busy, here's the two-minute version:",
    ],
    button: { label: "Plan my week", url: APP_URL },
    after: [],
  },

  /** 14. Ten days after the free time ended. Never to a paying subscriber. Once. */
  come_back: {
    subject: "Your plans are still here",
    greeting: "Hi {firstName},",
    body: [
      "Your free time ended a little while ago and your plans, lists and recipes are exactly where you left them. If Kiwi earned a spot in your week, it's $9.99 a month or $99.99 a year, cancel any time. If it didn't, I'd like to know why — just reply.",
    ],
    button: { label: "Subscribe to Kiwi", url: APP_URL },
    after: [],
  },
} satisfies Record<string, EmailCopy>;
