import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";

import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getDraftMealForImage } from "@/lib/stubs";

type Phase = "input" | "loading";

export default function ImportImageScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("input");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleCameraPick = async () => {
    setErrorMessage(null);
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      setErrorMessage(
        "Camera access is needed to take a photo. You can enable it in your device settings.",
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      quality: 0.8,
    });
    if (!result.canceled && result.assets && result.assets[0]) {
      processImage(result.assets[0].uri);
    }
  };

  const handleLibraryPick = async () => {
    setErrorMessage(null);
    const { status } =
      await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      setErrorMessage(
        "Photo library access is needed to pick an image. You can enable it in your device settings.",
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      // SDK 54 / image-picker 17 uses the MediaType union; MediaTypeOptions is deprecated.
      mediaTypes: ["images"],
      allowsEditing: true,
      quality: 0.8,
    });
    if (!result.canceled && result.assets && result.assets[0]) {
      processImage(result.assets[0].uri);
    }
  };

  const processImage = (imageUri: string) => {
    setErrorMessage(null);
    setPhase("loading");
    // Stub: simulate WS6 OCR + AI vision parse with 1500ms delay
    setTimeout(() => {
      const draft = getDraftMealForImage(imageUri);
      router.push({
        pathname: "/meal-builder",
        params: {
          draftSource: "image",
          draftJson: JSON.stringify(draft),
        },
      });
      setPhase("input");
    }, 1500);
  };

  if (phase === "loading") {
    return (
      <View style={styles.bg}>
        <Header title="Import from photo" />
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={KColors.sage[700]} />
          <Text style={styles.loadingTitle}>Reading your recipe...</Text>
          <Text style={styles.loadingSubtitle}>
            Kiwi is parsing the photo into structured ingredients and steps.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.bg}>
      <Header showBack title="Import from photo" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Snap or pick a recipe photo</Text>
        <Text style={styles.subtitle}>
          Kiwi can parse a recipe from a photo of a cookbook page, magazine
          clipping, or handwritten card.
        </Text>

        <ActionCard
          icon="camera"
          title="Take a photo"
          subtitle="Use your camera"
          onPress={handleCameraPick}
        />
        <ActionCard
          icon="image"
          title="Choose from library"
          subtitle="Pick an existing photo"
          onPress={handleLibraryPick}
        />

        {errorMessage && <Text style={styles.errorText}>{errorMessage}</Text>}

        <Text style={styles.helperText}>
          Works best with clear, well-lit photos. Kiwi will parse ingredients
          and steps for you.
        </Text>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

interface ActionCardProps {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  subtitle: string;
  onPress: () => void;
}

function ActionCard({ icon, title, subtitle, onPress }: ActionCardProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={styles.cardIconWrap}>
        <Feather name={icon} size={24} color={KColors.sage[700]} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardSubtitle}>{subtitle}</Text>
      </View>
      <Feather name="chevron-right" size={20} color={KColors.neutral[600]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: KColors.neutral[100] },
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.xl,
    paddingBottom: KSpacing.xxxl,
  },
  title: {
    fontSize: KType.size.xl,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
  },
  subtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
    marginBottom: KSpacing.xl,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    padding: KSpacing.md,
    marginBottom: KSpacing.md,
  },
  cardIconWrap: {
    width: 44,
    height: 44,
    borderRadius: KRadius.md,
    backgroundColor: KColors.sage[100],
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  cardSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  errorText: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
    marginTop: KSpacing.sm,
  },
  helperText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
    marginTop: KSpacing.lg,
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: KSpacing.xl,
    gap: KSpacing.md,
  },
  loadingTitle: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginTop: KSpacing.md,
  },
  loadingSubtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: KSpacing.md,
  },
});
