import React, { useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { Button } from "@/components/Button";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getRecipe } from "@/lib/mockData";
import { detectStepSeconds, formatTimer } from "@/lib/cookTimer";

export default function CookMode() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const recipe = id ? getRecipe(id) : undefined;

  const [step, setStep] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stepText = recipe?.steps[step] ?? "";
  const suggested = stepText ? detectStepSeconds(stepText) : null;

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setRemaining(suggested);
    setRunning(false);
  }, [step, suggested]);

  useEffect(() => {
    if (!running) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => {
      setRemaining((cur) => {
        if (cur === null || cur <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setRunning(false);
          Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          ).catch(() => {});
          return 0;
        }
        return cur - 1;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  if (!recipe) {
    return (
      <View style={s.bg}>
        <Text style={{ color: "#fff", padding: 40 }}>Recipe not found.</Text>
      </View>
    );
  }

  const total = recipe.steps.length;
  const isLast = step === total - 1;

  const next = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (isLast) {
      router.back();
    } else {
      setStep((x) => x + 1);
    }
  };

  const prev = () => {
    Haptics.selectionAsync().catch(() => {});
    setStep((x) => Math.max(0, x - 1));
  };

  const toggleTimer = () => {
    Haptics.selectionAsync().catch(() => {});
    if (remaining === 0 || remaining === null) {
      setRemaining(suggested ?? 60);
      setRunning(true);
      return;
    }
    setRunning((r) => !r);
  };

  const resetTimer = () => {
    Haptics.selectionAsync().catch(() => {});
    setRemaining(suggested ?? 60);
    setRunning(false);
  };

  return (
    <View style={[s.bg, { paddingTop: insets.top }]}>
      <View style={s.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={s.iconBtn}>
          <Feather name="x" size={24} color="#fff" />
        </Pressable>
        <Text style={s.topTitle}>{recipe.title}</Text>
        <View style={s.iconBtn} />
      </View>

      <View style={s.progressBar}>
        <View style={[s.progressFill, { width: `${((step + 1) / total) * 100}%` }]} />
      </View>

      <View style={s.imageWrap}>
        <Image source={recipe.image} style={s.image} />
        <View style={s.imageOverlay} />
      </View>

      <View style={s.content}>
        <Text style={s.stepLabel}>
          Step {step + 1} of {total}
        </Text>
        <Text style={s.stepText}>{stepText}</Text>

        {suggested !== null && (
          <View style={s.timerCard}>
            <View style={{ flex: 1 }}>
              <Text style={s.timerLabel}>Timer</Text>
              <Text style={s.timerValue}>
                {formatTimer(remaining ?? suggested)}
              </Text>
            </View>
            <Pressable
              onPress={resetTimer}
              hitSlop={10}
              style={({ pressed }) => [s.timerBtn, pressed && { opacity: 0.6 }]}
            >
              <Feather name="rotate-ccw" size={18} color="#fff" />
            </Pressable>
            <Pressable
              onPress={toggleTimer}
              hitSlop={10}
              style={({ pressed }) => [
                s.timerPlay,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Feather
                name={running ? "pause" : "play"}
                size={20}
                color={KColors.sage[900]}
              />
            </Pressable>
          </View>
        )}
      </View>

      <View
        style={[
          s.footer,
          { paddingBottom: Math.max(insets.bottom, KSpacing.md) + KSpacing.md },
        ]}
      >
        <Pressable
          onPress={prev}
          disabled={step === 0}
          style={({ pressed }) => [
            s.prevBtn,
            (step === 0 || pressed) && { opacity: 0.4 },
          ]}
        >
          <Feather name="chevron-left" size={20} color="#fff" />
          <Text style={s.prevText}>Back</Text>
        </Pressable>

        <View style={{ flex: 1 }}>
          <Button
            label={isLast ? "Done cooking" : "Next step"}
            variant="terra"
            onPress={next}
          />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: KColors.sage[900] },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: KSpacing.md,
    paddingTop: KSpacing.sm,
    paddingBottom: KSpacing.sm,
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  topTitle: {
    flex: 1,
    color: "#fff",
    fontSize: KType.size.md,
    fontWeight: "600",
    textAlign: "center",
    fontFamily: "Inter_600SemiBold",
  },
  progressBar: {
    height: 4,
    backgroundColor: "rgba(255,255,255,0.15)",
    marginHorizontal: KSpacing.lg,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: KColors.terracotta[400] },
  imageWrap: {
    marginTop: KSpacing.lg,
    marginHorizontal: KSpacing.lg,
    borderRadius: KRadius.xl,
    overflow: "hidden",
    height: 180,
  },
  image: { width: "100%", height: "100%" },
  imageOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(20,35,18,0.2)",
  },
  content: { padding: KSpacing.xl, flex: 1 },
  stepLabel: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[400],
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
  },
  stepText: {
    color: "#fff",
    fontSize: 22,
    lineHeight: 32,
    marginTop: KSpacing.md,
    fontWeight: "500",
    fontFamily: "Inter_500Medium",
  },
  timerCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    marginTop: KSpacing.xl,
    padding: KSpacing.md,
    borderRadius: KRadius.lg,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  timerLabel: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[400],
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
  timerValue: {
    fontSize: 28,
    color: "#fff",
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    fontFamily: "Inter_700Bold",
    marginTop: 2,
  },
  timerBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  timerPlay: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: KColors.terracotta[400],
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.md,
  },
  prevBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: KSpacing.md,
    paddingVertical: 14,
  },
  prevText: {
    color: "#fff",
    fontSize: KType.size.md,
    fontWeight: "500",
    fontFamily: "Inter_500Medium",
  },
});
