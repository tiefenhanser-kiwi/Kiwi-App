import React, { useMemo, useState } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { Screen } from "@/components/Screen";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { RECIPES } from "@/lib/mockData";

const FILTERS = ["All", "Favorites", "Quick", "Vegan", "Comfort"] as const;
type Filter = (typeof FILTERS)[number];

export default function Library() {
  const router = useRouter();
  const { favorites, toggleFavorite } = useApp();
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return RECIPES.filter((r) => {
      if (filter === "Favorites" && !favorites.includes(r.id)) return false;
      if (filter === "Quick" && r.minutes > 25) return false;
      if (filter === "Vegan" && !r.tags.includes("vegan")) return false;
      if (filter === "Comfort" && !r.tags.includes("comfort")) return false;
      if (q) {
        const hay = `${r.title} ${r.cuisine} ${r.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [filter, query, favorites]);

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        title="Recipe Library"
        subtitle={`${RECIPES.length} recipes`}
        showBack
      />
      <Screen>
        <View style={s.searchRow}>
          <Feather name="search" size={16} color={KColors.neutral[600]} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search recipes, cuisines, tags…"
            placeholderTextColor={KColors.neutral[600]}
            style={s.search}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery("")} hitSlop={10}>
              <Feather name="x" size={16} color={KColors.neutral[700]} />
            </Pressable>
          )}
        </View>

        <View style={s.filterRow}>
          {FILTERS.map((f) => (
            <Chip
              key={f}
              label={f}
              selected={filter === f}
              onPress={() => setFilter(f)}
            />
          ))}
        </View>

        {items.length === 0 ? (
          <View style={s.empty}>
            <Feather name="coffee" size={32} color={KColors.neutral[600]} />
            <Text style={s.emptyText}>
              No recipes match. Try a different filter.
            </Text>
          </View>
        ) : (
          <View style={s.grid}>
            {items.map((r) => {
              const fav = favorites.includes(r.id);
              return (
                <Pressable
                  key={r.id}
                  onPress={() => router.push(`/recipe/${r.id}`)}
                  style={({ pressed }) => [
                    s.tile,
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Image source={r.image} style={s.tileImage} />
                  <Pressable
                    onPress={() => toggleFavorite(r.id)}
                    hitSlop={10}
                    style={s.heartBtn}
                  >
                    <Feather
                      name="heart"
                      size={16}
                      color={fav ? KColors.terracotta[400] : "#fff"}
                      style={fav ? s.heartFilled : undefined}
                    />
                  </Pressable>
                  <View style={s.tileBody}>
                    <Text style={s.tileTitle} numberOfLines={1}>
                      {r.title}
                    </Text>
                    <Text style={s.tileMeta}>
                      {r.cuisine} · {r.minutes}m
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </Screen>
    </View>
  );
}

const s = StyleSheet.create({
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
  },
  search: {
    flex: 1,
    paddingVertical: 12,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: KSpacing.md,
    marginBottom: KSpacing.lg,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: KSpacing.md,
  },
  tile: {
    width: "48%",
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    overflow: "hidden",
  },
  tileImage: {
    width: "100%",
    height: 110,
    backgroundColor: KColors.neutral[200],
  },
  heartBtn: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(20,35,18,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  heartFilled: {
    textShadowColor: "rgba(0,0,0,0.3)",
    textShadowRadius: 2,
  },
  tileBody: { padding: KSpacing.sm },
  tileTitle: {
    fontSize: KType.size.sm,
    fontWeight: "600",
    color: KColors.neutral[900],
    fontFamily: "Inter_600SemiBold",
  },
  tileMeta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    marginTop: 2,
    fontFamily: "Inter_400Regular",
  },
  empty: {
    alignItems: "center",
    paddingVertical: 60,
    gap: KSpacing.md,
  },
  emptyText: {
    color: KColors.neutral[700],
    fontSize: KType.size.md,
    fontFamily: "Inter_400Regular",
  },
});
