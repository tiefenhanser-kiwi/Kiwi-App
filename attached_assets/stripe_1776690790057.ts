// kiwi/server/src/integrations/stripe.ts
// All Stripe interactions go through this module.
// Never call Stripe directly from routes or services.

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
});

export const PRICE_IDS = {
  monthly: process.env.STRIPE_PREMIUM_PRICE_ID_MONTHLY!,
  annual:  process.env.STRIPE_PREMIUM_PRICE_ID_ANNUAL!,
} as const;

// ── CUSTOMER ──

export async function createCustomer(params: {
  email: string;
  name: string;
  userId: string;
}): Promise<Stripe.Customer> {
  return stripe.customers.create({
    email: params.email,
    name: params.name,
    metadata: { kiwiUserId: params.userId },
  });
}

export async function getCustomer(customerId: string): Promise<Stripe.Customer> {
  return stripe.customers.retrieve(customerId) as Promise<Stripe.Customer>;
}

// ── CHECKOUT ──

export async function createCheckoutSession(params: {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  trialDays?: number;
  promoCode?: string;
}): Promise<Stripe.Checkout.Session> {
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    customer: params.customerId,
    mode: 'subscription',
    payment_method_types: ['card', 'apple_pay', 'google_pay', 'paypal', 'link'],
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    subscription_data: {
      trial_period_days: params.trialDays,
    },
  };

  if (params.promoCode) {
    const promo = await stripe.promotionCodes.list({ code: params.promoCode });
    if (promo.data.length > 0) {
      sessionParams.discounts = [{ promotion_code: promo.data[0].id }];
    }
  }

  return stripe.checkout.sessions.create(sessionParams);
}

// ── SUBSCRIPTION ──

export async function getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  return stripe.subscriptions.retrieve(subscriptionId);
}

export async function cancelSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  return stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
}

export async function applyPromoCode(params: {
  subscriptionId: string;
  promoCode: string;
}): Promise<Stripe.Subscription> {
  const promo = await stripe.promotionCodes.list({ code: params.promoCode });
  if (promo.data.length === 0) throw new Error('Invalid promo code');

  return stripe.subscriptions.update(params.subscriptionId, {
    discounts: [{ promotion_code: promo.data[0].id }],
  });
}

// ── WEBHOOKS ──

export function constructWebhookEvent(
  payload: Buffer,
  signature: string
): Stripe.Event {
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!
  );
}

// ── PORTAL ──

export async function createPortalSession(params: {
  customerId: string;
  returnUrl: string;
}): Promise<Stripe.BillingPortal.Session> {
  return stripe.billingPortal.sessions.create({
    customer: params.customerId,
    return_url: params.returnUrl,
  });
}


// kiwi/server/src/services/subscription.service.ts
// Subscription state and entitlement checks.
// ALL feature gating goes through this service — never check raw billing data in routes.

import { PrismaClient } from '@prisma/client';
import * as StripeLib from '../integrations/stripe';

const db = new PrismaClient();

export type EntitlementKey =
  | 'grocery_ordering'
  | 'full_cook_intelligence'
  | 'unlimited_plans'
  | 'ad_free';

export async function can(userId: string, entitlement: EntitlementKey): Promise<boolean> {
  const sub = await db.subscription.findUnique({ where: { userId } });
  if (!sub) return false;

  const isPremium = (
    (sub.status === 'active' || sub.status === 'trialing') &&
    (sub.planCode === 'premium_monthly' || sub.planCode === 'premium_annual')
  );

  // Trial users get full premium access
  const isTrialing = sub.status === 'trialing' && sub.trialEndsAt && new Date(sub.trialEndsAt) > new Date();

  const hasAccess = isPremium || isTrialing;

  switch (entitlement) {
    case 'grocery_ordering':     return hasAccess;
    case 'full_cook_intelligence': return hasAccess;
    case 'unlimited_plans':      return hasAccess;
    case 'ad_free':              return hasAccess;
    default: return false;
  }
}

export async function getMaxPlans(userId: string): Promise<number> {
  const hasUnlimited = await can(userId, 'unlimited_plans');
  return hasUnlimited ? Infinity : (parseInt(process.env.FREE_TIER_MAX_PLANS || '4', 10));
}

export async function getCurrentPlanCount(userId: string): Promise<number> {
  const count = await db.mealPlanTemplate.count({
    where: { userId, isArchived: false },
  });
  return count;
}

export async function getDeletedPlanCount(userId: string): Promise<number> {
  const template = await db.mealPlanTemplate.findMany({
    where: { userId },
    select: { deletedPlanCount: true },
  });
  return template.reduce((sum, t) => sum + t.deletedPlanCount, 0);
}

export async function canCreatePlan(userId: string): Promise<{ allowed: boolean; reason?: string }> {
  const [maxPlans, currentCount] = await Promise.all([
    getMaxPlans(userId),
    getCurrentPlanCount(userId),
  ]);

  if (currentCount >= maxPlans) {
    return {
      allowed: false,
      reason: `Free tier allows ${maxPlans} saved plans. Upgrade to Premium for unlimited plans, or compost an existing plan.`,
    };
  }

  return { allowed: true };
}

export async function startTrial(userId: string, stripeCustomerId: string): Promise<void> {
  const trialDays = parseInt(process.env.DEFAULT_TRIAL_DAYS || '30', 10);
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

  await db.subscription.upsert({
    where: { userId },
    create: {
      userId,
      planCode: 'premium_monthly',
      status: trialDays > 0 ? 'trialing' : 'none',
      trialEndsAt: trialDays > 0 ? trialEndsAt : undefined,
      stripeCustomerId,
    },
    update: {
      stripeCustomerId,
    },
  });

  await db.user.update({
    where: { id: userId },
    data: {
      subscriptionStatus: trialDays > 0 ? 'trialing' : 'none',
    },
  });
}

export async function handleStripeWebhook(event: any): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      await syncSubscriptionFromStripe(sub);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await db.subscription.update({
        where: { stripeSubscriptionId: sub.id },
        data: { status: 'canceled' },
      });
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      if (invoice.subscription) {
        await db.subscription.update({
          where: { stripeSubscriptionId: invoice.subscription as string },
          data: { status: 'past_due' },
        });
      }
      break;
    }
  }
}

async function syncSubscriptionFromStripe(stripeSub: any): Promise<void> {
  const planCode = stripeSub.items.data[0]?.price?.id === StripeLib.PRICE_IDS.annual
    ? 'premium_annual'
    : 'premium_monthly';

  const statusMap: Record<string, string> = {
    active:   'active',
    trialing: 'trialing',
    past_due: 'past_due',
    canceled: 'canceled',
    unpaid:   'past_due',
  };

  await db.subscription.upsert({
    where: { stripeSubscriptionId: stripeSub.id },
    create: {
      userId: stripeSub.metadata.kiwiUserId,
      planCode: planCode as any,
      status: (statusMap[stripeSub.status] || 'none') as any,
      stripeSubscriptionId: stripeSub.id,
      stripeCustomerId: stripeSub.customer,
      currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
      trialEndsAt: stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : undefined,
    },
    update: {
      planCode: planCode as any,
      status: (statusMap[stripeSub.status] || 'none') as any,
      currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
      trialEndsAt: stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : undefined,
    },
  });
}
