// Resub C2 — THE PURCHASE SHEET'S BODY ON iOS AND ANDROID.
//
// Apple rejected 1.0 under 3.1.1 (a subscription that could not be bought in the
// app). This is where it is bought: the current RevenueCat offering's monthly and
// annual packages at the STORE's localized prices, with everything 3.1.2 asks to
// be on the purchase screen itself — what the subscription includes, the price
// per period, the renewal and cancellation terms with the store named, the Terms
// of Use and Privacy links — and Restore Purchases.
//
// PRESENTATIONAL ON PURPOSE. Every input is a prop, so each state (loading,
// unavailable, buying, confirming, stalled) renders under test without a store,
// a provider or a device. PaywallSheet passes BillingContext's store state in.
//
// 🔴 TWO STATES SHOW NO BUY BUTTON, AND BOTH ARE ABOUT MONEY:
//   · unavailable — no key on the build, no RevenueCat on the server, or no
//     offering. A purchase there could take money that never unlocks the account.
//   · confirming / stalled — the store has taken the money and Kiwi has not
//     heard yet. The next step is a retry of the sync, never a second purchase.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Colors, Palette, Spacing, Typography } from "@/constants/tokens";
import type { BillingPlan } from "@/lib/billing/api";
import {
  SHEET_BENEFITS,
  SHEET_BILLING_STARTS_TODAY,
  SHEET_CONFIRMING,
  SHEET_CONFIRM_RETRY,
  SHEET_CONFIRM_STALLED,
  SHEET_INCLUDES_HEADING,
  SHEET_LAPSED_BODY,
  SHEET_LOADING_PRICES,
  SHEET_PRIVACY_LINK,
  SHEET_RESTORE,
  SHEET_STORE_UNAVAILABLE,
  SHEET_TERMS_LINK,
  storePriceLabel,
  storeTermsPayment,
  storeTermsPrices,
} from "@/lib/billing/copy";
import type { StoreOfferView } from "@/lib/billing/store";
import type { SheetState, StoreSource } from "@/lib/billing/subscriptionView";
import { PRIVACY_URL, TERMS_URL } from "@/lib/legal";

export type NativeOfferStatus = "idle" | "loading" | "ready" | "unavailable";
export type NativeStorePhase = "idle" | "purchasing" | "restoring" | "confirming" | "stalled";

export interface NativePurchasePanelProps {
  /** Which store this device sells through — named in the 3.1.2 terms. */
  store: StoreSource;
  sheet: SheetState;
  offerStatus: NativeOfferStatus;
  offer: StoreOfferView | null;
  phase: NativeStorePhase;
  message: string | null;
  onBuy: (plan: BillingPlan) => void;
  onRestore: () => void;
  onCheckAgain: () => void;
  onOpenLegal: (url: string) => void;
}

export function NativePurchasePanel({
  store,
  sheet,
  offerStatus,
  offer,
  phase,
  message,
  onBuy,
  onRestore,
  onCheckAgain,
  onOpenLegal,
}: NativePurchasePanelProps) {
  const ready = offerStatus === "ready" && offer !== null;
  const confirming = phase === "confirming";
  const stalled = phase === "stalled";
  const busy = phase === "purchasing" || phase === "restoring";
  const canBuy = ready && !confirming && !stalled;
  const packages = ready
    ? [offer.monthly, offer.annual].filter((p): p is NonNullable<typeof p> => p !== null)
    : [];

  return (
    <View style={s.wrap} testID="store-panel">
      {sheet === "lapsed" ? <Text style={s.lapsedBody}>{SHEET_LAPSED_BODY}</Text> : null}

      {/* 3.1.2 — what the subscription includes. */}
      <View style={s.list}>
        <Text style={s.heading}>{SHEET_INCLUDES_HEADING}</Text>
        {SHEET_BENEFITS.map((line) => (
          <View key={line} style={s.row}>
            <Feather name="check" size={16} color={Colors.sage[700]} />
            <Text style={s.rowText}>{line}</Text>
          </View>
        ))}
      </View>

      {/* No bonus, no "first charge on" date (Hans, October 4). */}
      {sheet === "trialing" ? (
        <Text style={s.note} testID="store-billing-today">
          {SHEET_BILLING_STARTS_TODAY}
        </Text>
      ) : null}

      {offerStatus === "loading" ? (
        <Text style={s.note} testID="store-loading">
          {SHEET_LOADING_PRICES}
        </Text>
      ) : null}

      {offerStatus === "unavailable" ? (
        <Text style={s.note} testID="store-unavailable">
          {SHEET_STORE_UNAVAILABLE}
        </Text>
      ) : null}

      {confirming ? (
        <Text style={s.confirming} testID="store-confirming">
          {SHEET_CONFIRMING}
        </Text>
      ) : null}

      {stalled ? (
        <View style={s.stalled}>
          <Text style={s.note} testID="store-stalled">
            {SHEET_CONFIRM_STALLED}
          </Text>
          <Button
            label={SHEET_CONFIRM_RETRY}
            variant="secondary"
            onPress={onCheckAgain}
            testID="store-check-again"
          />
        </View>
      ) : null}

      {canBuy ? (
        <View style={s.prices}>
          {packages.map((p) => (
            <Button
              key={p.plan}
              label={storePriceLabel(p.priceString, p.period)}
              variant="primary"
              disabled={busy}
              loading={phase === "purchasing"}
              onPress={() => onBuy(p.plan)}
              testID={`store-buy-${p.plan}`}
            />
          ))}
        </View>
      ) : null}

      {message !== null ? (
        <Text style={s.message} testID="store-message">
          {message}
        </Text>
      ) : null}

      {/* 3.1.2 — price per period and the renewal terms, on the sheet itself. */}
      {ready ? (
        <Text style={s.terms} testID="store-terms">
          {storeTermsPrices(offer.monthly?.priceString ?? null, offer.annual?.priceString ?? null)}{" "}
          {storeTermsPayment(store)}
        </Text>
      ) : null}

      <View style={s.links}>
        <Pressable
          onPress={() => onOpenLegal(TERMS_URL)}
          hitSlop={8}
          accessibilityRole="link"
          testID="store-link-terms"
        >
          <Text style={s.link}>{SHEET_TERMS_LINK}</Text>
        </Pressable>
        <Text style={s.linkDot}>·</Text>
        <Pressable
          onPress={() => onOpenLegal(PRIVACY_URL)}
          hitSlop={8}
          accessibilityRole="link"
          testID="store-link-privacy"
        >
          <Text style={s.link}>{SHEET_PRIVACY_LINK}</Text>
        </Pressable>
      </View>

      {canBuy ? (
        <Button
          label={SHEET_RESTORE}
          variant="ghost"
          size="sm"
          disabled={busy}
          loading={phase === "restoring"}
          onPress={onRestore}
          testID="store-restore"
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: Spacing[3] },
  lapsedBody: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },
  heading: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  list: { gap: Spacing[2] },
  row: { flexDirection: "row", alignItems: "flex-start", gap: Spacing[2] },
  rowText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  note: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
    textAlign: "center",
    lineHeight: 18,
  },
  confirming: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[500],
    textAlign: "center",
  },
  stalled: { gap: Spacing[2] },
  prices: { gap: Spacing[2] },
  message: {
    fontSize: Typography.fontSize.sm,
    color: Palette.text.danger,
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    lineHeight: 18,
  },
  terms: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 16,
  },
  links: { flexDirection: "row", justifyContent: "center", gap: Spacing[2] },
  link: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[600],
    textDecorationLine: "underline",
  },
  linkDot: { fontSize: Typography.fontSize.xs, color: Colors.neutral[600] },
});
