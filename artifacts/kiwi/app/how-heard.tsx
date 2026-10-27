// CLIENT-3 D (ATTR) — the route for "How did you hear about Kiwi?". Reached
// only through lib/howHeard.ts landingAfterAuth (a sign-up that created the
// account), with `next` = where that sign-up was going. An answer or Skip
// replaces this screen with `next`, so Back cannot return to it; the device
// marker (set on arrival) sends a reload or a second visit straight on.

import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { HowHeardView } from "@/components/HowHeardView";
import { useAuth } from "@/contexts/AuthContext";
import { Colors } from "@/constants/tokens";
import {
  howHeardBody,
  howHeardNext,
  markHowHeardAsked,
  sendHowHeard,
  wasHowHeardAsked,
  type HowHeard,
} from "@/lib/howHeard";

export default function HowHeardScreen() {
  const router = useRouter();
  const { next: nextParam } = useLocalSearchParams<{ next?: string }>();
  const next = howHeardNext(nextParam);
  const { user, isLoading } = useAuth();
  const userId = user?.id ?? null;
  // null = checking the marker; nothing renders until it is read.
  const [show, setShow] = useState<boolean | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!userId) {
      router.replace(next);
      return;
    }
    let live = true;
    void (async () => {
      const asked = await wasHowHeardAsked(userId);
      if (!live) return;
      if (asked) {
        router.replace(next);
        return;
      }
      await markHowHeardAsked(userId);
      if (live) setShow(true);
    })();
    return () => {
      live = false;
    };
  }, [isLoading, userId, next, router]);

  const onAnswer = (value: HowHeard, detail?: string) => {
    sendHowHeard(howHeardBody(value, detail));
    router.replace(next);
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      {show ? <HowHeardView onAnswer={onAnswer} onSkip={() => router.replace(next)} /> : null}
    </View>
  );
}
