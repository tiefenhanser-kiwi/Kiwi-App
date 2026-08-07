import { Feather } from "@expo/vector-icons";
import { reloadAppAsync } from "expo";
import React, { useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Palette, Radius, Shadow, Typography } from "@/constants/tokens";

// v4 (A1) migration (WS9 L2/B2, BUG-034): this screen previously read the
// pre-v4 green palette via useColors()/constants/colors.ts — it was the last
// consumer of that fork, so both files are removed with this change. Semantic
// names below map the old useColors() keys onto v4 tokens 1:1.
const palette = {
  background: Palette.background.app,
  card: Palette.background.card,
  foreground: Palette.text.primary,
  mutedForeground: Palette.text.muted,
  border: Palette.border.default,
  primary: Palette.button.primary.background,
  primaryForeground: Palette.button.primary.text,
};

export type ErrorFallbackProps = {
  error: Error;
  resetError: () => void;
};

export function ErrorFallback({ error, resetError }: ErrorFallbackProps) {
  const insets = useSafeAreaInsets();

  const [isModalVisible, setIsModalVisible] = useState(false);

  const handleRestart = async () => {
    try {
      await reloadAppAsync();
    } catch (restartError) {
      console.error("Failed to restart app:", restartError);
      resetError();
    }
  };

  const formatErrorDetails = (): string => {
    let details = `Error: ${error.message}\n\n`;
    if (error.stack) {
      details += `Stack Trace:\n${error.stack}`;
    }
    return details;
  };

  const monoFont = Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "monospace",
  });

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      {__DEV__ ? (
        <Pressable
          onPress={() => setIsModalVisible(true)}
          accessibilityLabel="View error details"
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.topButton,
            {
              top: insets.top + 16,
              backgroundColor: palette.card,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Feather name="alert-circle" size={20} color={palette.foreground} />
        </Pressable>
      ) : null}

      <View style={styles.content}>
        <Text style={[styles.title, { color: palette.foreground }]}>
          Something went wrong
        </Text>

        <Text style={[styles.message, { color: palette.mutedForeground }]}>
          Please reload the app to continue.
        </Text>

        <Pressable
          onPress={handleRestart}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: palette.primary,
              opacity: pressed ? 0.9 : 1,
              transform: [{ scale: pressed ? 0.98 : 1 }],
            },
          ]}
        >
          <Text
            style={[
              styles.buttonText,
              { color: palette.primaryForeground },
            ]}
          >
            Try Again
          </Text>
        </Pressable>
      </View>

      {__DEV__ ? (
        <Modal
          visible={isModalVisible}
          animationType="slide"
          transparent={true}
          statusBarTranslucent
          navigationBarTranslucent
          onRequestClose={() => setIsModalVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View
              style={[
                styles.modalContainer,
                { backgroundColor: palette.background },
              ]}
            >
              <View
                style={[
                  styles.modalHeader,
                  { borderBottomColor: palette.border },
                ]}
              >
                <Text style={[styles.modalTitle, { color: palette.foreground }]}>
                  Error Details
                </Text>
                <Pressable
                  onPress={() => setIsModalVisible(false)}
                  accessibilityLabel="Close error details"
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.closeButton,
                    { opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <Feather name="x" size={24} color={palette.foreground} />
                </Pressable>
              </View>

              <ScrollView
                style={styles.modalScrollView}
                contentContainerStyle={[
                  styles.modalScrollContent,
                  { paddingBottom: insets.bottom + 16 },
                ]}
                showsVerticalScrollIndicator
              >
                <View
                  style={[
                    styles.errorContainer,
                    { backgroundColor: palette.card },
                  ]}
                >
                  <Text
                    style={[
                      styles.errorText,
                      {
                        color: palette.foreground,
                        fontFamily: monoFont,
                      },
                    ]}
                    selectable
                  >
                    {formatErrorDetails()}
                  </Text>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  content: {
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    width: "100%",
    maxWidth: 600,
  },
  title: {
    fontSize: 28,
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.sans[700],
    textAlign: "center",
    lineHeight: 40,
  },
  message: {
    fontSize: 16,
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    lineHeight: 24,
  },
  topButton: {
    position: "absolute",
    right: 16,
    width: 44,
    height: 44,
    borderRadius: Radius.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  button: {
    paddingVertical: 16,
    borderRadius: Radius.sm,
    paddingHorizontal: 24,
    minWidth: 200,
    shadowColor: Shadow.card.shadowColor,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  buttonText: {
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textAlign: "center",
    fontSize: 16,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: Palette.background.overlay,
    justifyContent: "flex-end",
  },
  modalContainer: {
    width: "100%",
    height: "90%",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  modalScrollView: {
    flex: 1,
  },
  modalScrollContent: {
    padding: 16,
  },
  errorContainer: {
    width: "100%",
    borderRadius: Radius.sm,
    overflow: "hidden",
    padding: 16,
  },
  errorText: {
    fontSize: Typography.fontSize.sm,
    lineHeight: 18,
    width: "100%",
  },
});
