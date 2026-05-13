import React, { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { importRecipeFromImage } from "@/lib/api/recipeImport";

type Phase = "input" | "loading";
const MAX_IMAGES = 5;

export default function ImportImageScreen() {
  const router = useRouter();
  const { addToPlanId } = useLocalSearchParams<{ addToPlanId?: string }>();
  const [selectedImages, setSelectedImages] = useState<{ uri: string }[]>([]);
  const [phase, setPhase] = useState<Phase>("input");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const remainingSlots = MAX_IMAGES - selectedImages.length;
  const atCapacity = remainingSlots <= 0;

  const handleLibraryPick = async () => {
    setErrorMessage(null);
    if (atCapacity) return;
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
      allowsMultipleSelection: true,
      selectionLimit: remainingSlots,
      quality: 0.8,
    });
    if (!result.canceled && result.assets?.length) {
      const newImages = result.assets
        .slice(0, remainingSlots)
        .map((a) => ({ uri: a.uri }));
      setSelectedImages((prev) => [...prev, ...newImages]);
    }
  };

  const handleCameraPick = async () => {
    setErrorMessage(null);
    if (atCapacity) return;
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      setErrorMessage(
        "Camera access is needed to take a photo. You can enable it in your device settings.",
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      // allowsEditing intentionally omitted — the system edit/crop screen
      // is flaky on Android (missing Done button blocks progression). For
      // OCR the full as-shot frame is better anyway (more text for AI).
      quality: 0.8,
    });
    if (!result.canceled && result.assets?.[0]) {
      const uri = result.assets[0].uri;
      setSelectedImages((prev) => [...prev, { uri }]);
    }
  };

  const removeImage = (index: number) => {
    setSelectedImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleImport = async () => {
    if (selectedImages.length === 0) return;
    setErrorMessage(null);
    setPhase("loading");
    try {
      const result = await importRecipeFromImage({
        imageUris: selectedImages.map((i) => i.uri),
      });
      if (!result.success) {
        setErrorMessage(result.userFacingMessage);
        setPhase("input");
        return;
      }
      router.push({
        pathname: "/meal-builder",
        params: {
          draftSource: "image",
          draftJson: JSON.stringify(result.draft),
          ...(addToPlanId ? { addToPlanId } : {}),
        },
      });
      setPhase("input");
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Kiwi couldn't read this recipe. Try Import from URL instead.",
      );
      setPhase("input");
    }
  };

  if (phase === "loading") {
    const pluralPhotos = selectedImages.length === 1 ? "photo" : "photos";
    return (
      <View style={styles.bg}>
        <Header title="Import from photo" />
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={KColors.sage[700]} />
          <Text style={styles.loadingTitle}>Reading your recipe...</Text>
          <Text style={styles.loadingSubtitle}>
            Kiwi is parsing the {pluralPhotos} into structured ingredients and
            steps.
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
        <Text style={styles.title}>Snap or pick recipe photos</Text>
        <Text style={styles.subtitle}>
          Kiwi can parse a recipe from up to 5 images.
        </Text>

        <View style={styles.buttonWrap}>
          <Button
            label="Choose from Library"
            variant="primary"
            disabled={atCapacity}
            onPress={handleLibraryPick}
            iconLeft={
              <Feather name="image" size={18} color={KColors.neutral[100]} />
            }
          />
        </View>
        <View style={styles.buttonWrap}>
          <Button
            label="Take Photo"
            variant="secondary"
            disabled={atCapacity}
            onPress={handleCameraPick}
            iconLeft={
              <Feather name="camera" size={18} color={KColors.sage[700]} />
            }
          />
        </View>

        {selectedImages.length > 0 && (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.thumbStrip}
            >
              {selectedImages.map((img, idx) => (
                <View key={`${img.uri}-${idx}`} style={styles.thumbWrap}>
                  <Image source={{ uri: img.uri }} style={styles.thumb} />
                  <Pressable
                    onPress={() => removeImage(idx)}
                    style={styles.removeBadge}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove image ${idx + 1}`}
                  >
                    <Feather name="x" size={14} color={KColors.neutral[100]} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
            <Text style={styles.counter}>
              {selectedImages.length} of {MAX_IMAGES} images
            </Text>
          </>
        )}

        <View style={styles.buttonWrap}>
          <Button
            label="Import Recipe"
            variant="primary"
            disabled={selectedImages.length === 0}
            onPress={handleImport}
          />
        </View>

        {errorMessage && <Text style={styles.errorText}>{errorMessage}</Text>}

        <Text style={styles.helperText}>
          Works with screenshots from any site, photos of cookbooks, or recipe
          cards.
        </Text>
      </KeyboardAwareScrollViewCompat>
    </View>
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
  buttonWrap: {
    marginBottom: KSpacing.md,
  },
  thumbStrip: {
    paddingVertical: KSpacing.sm,
    gap: KSpacing.sm,
  },
  thumbWrap: {
    width: 72,
    height: 72,
    marginRight: KSpacing.sm,
    position: "relative",
  },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: KRadius.md,
    backgroundColor: KPalette.bg.card,
  },
  removeBadge: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: KColors.terracotta[700],
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: KColors.neutral[100],
  },
  counter: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginBottom: KSpacing.md,
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
