import React, { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Header } from "@/components/Header";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { getStaples, removeStaple, STAPLES_QUERY_KEY, type Staple } from "@/lib/api/staples";
import { STAPLES_COPY, STAPLES_EMPTY } from "@/lib/staples";

// CLIENT-9 D (BUG-472) — Profile → Staples: the things the cook always has, which
// Kiwi keeps off their grocery list (GET /me/staples), each with a remove (DELETE
// /me/staples/:id, which also brings the item back onto their open lists). A
// staple is added from a grocery row: press and hold, "I always have this".
//
// Web parity: every outcome is inline text on this screen — no Alert.

export default function StaplesScreen() {
  const queryClient = useQueryClient();
  const query = useQuery<Staple[]>({ queryKey: STAPLES_QUERY_KEY, queryFn: getStaples });
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const handleRemove = async (staple: Staple) => {
    if (removing.has(staple.id)) return;
    setError(null);
    setRemoving((prev) => new Set(prev).add(staple.id));
    // Optimistic: the row leaves at once; a failure puts it back.
    queryClient.setQueryData<Staple[]>(STAPLES_QUERY_KEY, (prev) => prev?.filter((x) => x.id !== staple.id));
    try {
      await removeStaple(staple.id);
      // The server unmarked its rows on the open lists: they read fresh next time.
      void queryClient.invalidateQueries({ queryKey: ["groceries"] });
    } catch {
      setError(`Couldn't remove ${staple.name}. Please try again.`);
      void queryClient.invalidateQueries({ queryKey: STAPLES_QUERY_KEY });
    } finally {
      setRemoving((prev) => {
        const next = new Set(prev);
        next.delete(staple.id);
        return next;
      });
    }
  };

  const staples = query.data ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header showBack title="Staples" />
      <ScrollView contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={s.body}>{STAPLES_COPY}</Text>
        {error && <Text style={s.error}>{error}</Text>}
        {query.isPending ? (
          <ActivityIndicator color={Colors.sage[700]} style={{ marginTop: Spacing[4] }} />
        ) : query.isError ? (
          <View style={s.card}>
            <Text style={s.body}>Couldn't load your staples.</Text>
            <Pressable onPress={() => void query.refetch()} accessibilityRole="button" hitSlop={8}>
              <Text style={s.link}>Try again</Text>
            </Pressable>
          </View>
        ) : staples.length === 0 ? (
          <View style={s.card}>
            <Text style={s.body}>{STAPLES_EMPTY}</Text>
          </View>
        ) : (
          <View style={s.card}>
            {staples.map((staple, i) => (
              <View key={staple.id} style={[s.row, i > 0 && s.rowDivider]}>
                <Text style={s.name}>{staple.name}</Text>
                <Pressable
                  onPress={() => void handleRemove(staple)}
                  disabled={removing.has(staple.id)}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${staple.name} from staples`}
                  style={({ pressed }) => [s.remove, pressed && { opacity: 0.6 }]}
                >
                  <Feather name="x" size={18} color={Colors.neutral[600]} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: Spacing[8] * 2,
    gap: Spacing[3],
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
  },
  body: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  link: {
    marginTop: Spacing[2],
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
  },
  error: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[500],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    paddingVertical: Spacing[2],
  },
  rowDivider: {
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[200],
  },
  name: {
    flex: 1,
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
  },
  remove: {
    padding: Spacing[1],
  },
});
