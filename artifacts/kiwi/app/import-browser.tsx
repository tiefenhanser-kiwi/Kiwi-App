// IMPORT-2 (D-WS9-384) — "Open the site and import". 1.2-only (the 1.1 binary
// has no WebView module).
//
// Two steps on one route: pick a site (a field, the cook's recent sites, a few
// recipe sites), then browse it in an in-app WebView with "Import this page"
// pinned to the bottom. Import reads the page the cook is looking at and sends
// it through the existing URL import (lib/api/recipeImport.ts, `html`); the
// review screen (/meal-builder, draftSource "url") takes over from there.
// Decisions — the field, recent sites, navigation, the page script and its
// answer — are lib/import/inAppBrowser.ts.
//
// 🔴 Nothing here reads, stores or sends a site's credentials. A sign-in lives
// in the WebView's own cookie jar, which is persistent (incognito is off) so it
// survives the next visit. One tap sends one page; nothing loads in the
// background and nothing is retried.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { importRecipeFromUrl } from "@/lib/api/recipeImport";
import {
  addRecentSite,
  browserAllowsNavigation,
  displayHost,
  normalizeSiteInput,
  PAGE_CAPTURE_FAILED_MESSAGE,
  PAGE_CAPTURE_TIMEOUT_MS,
  pageCaptureScript,
  parsePageCaptureMessage,
  readRecentSites,
  RECENT_SITES_KEY,
  RECIPE_SITES,
  showsSiteImport,
  siteLabel,
} from "@/lib/import/inAppBrowser";
import { loadJSON, newId, saveJSON } from "@/lib/storage";

type FlowParams = {
  addToPlanId?: string;
  planId?: string;
  planItemId?: string;
  toPlaylist?: string;
};

export default function ImportBrowserScreen() {
  // Same context params as /import-url: they ride through to the builder's
  // CREATE branch (append / replace / playlist / detail).
  const { addToPlanId, planId, planItemId, toPlaylist } = useLocalSearchParams<FlowParams>();
  const flowParams: FlowParams = {
    ...(addToPlanId ? { addToPlanId } : {}),
    ...(planId ? { planId } : {}),
    ...(planItemId ? { planItemId } : {}),
    ...(toPlaylist ? { toPlaylist } : {}),
  };
  const [siteUrl, setSiteUrl] = useState<string | null>(null);

  if (!showsSiteImport(Platform.OS)) {
    return (
      <View style={styles.bg}>
        <Header showBack title="Open the site" />
        <View style={styles.webOnly}>
          <Text style={styles.subtitle}>
            Opening a recipe site to import works in the Kiwi app on your phone. Here,
            paste the recipe link instead.
          </Text>
        </View>
      </View>
    );
  }

  return siteUrl ? (
    <PageBrowser startUrl={siteUrl} flowParams={flowParams} onClose={() => setSiteUrl(null)} />
  ) : (
    <SitePicker onOpen={setSiteUrl} />
  );
}

function SitePicker({ onOpen }: { onOpen: (url: string) => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    loadJSON<unknown>(RECENT_SITES_KEY, []).then((stored) => {
      if (live) setRecent(readRecentSites(stored));
    });
    return () => {
      live = false;
    };
  }, []);

  const open = (url: string) => {
    Keyboard.dismiss();
    const next = addRecentSite(recent, url);
    setRecent(next);
    void saveJSON(RECENT_SITES_KEY, next);
    onOpen(url);
  };

  const submit = () => {
    const url = normalizeSiteInput(input);
    if (!url) {
      setError("That doesn't look like a web address. Try something like cooking.nytimes.com.");
      return;
    }
    setError(null);
    open(url);
  };

  return (
    <View style={styles.bg}>
      <Header showBack title="Open the site" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Open a recipe site</Text>
        <Text style={styles.subtitle}>
          For a site that needs you to sign in, or one Kiwi can't read from a link. Find the
          recipe, then tap Import this page.
        </Text>

        <TextInput
          value={input}
          onChangeText={(v) => {
            setInput(v);
            if (error) setError(null);
          }}
          placeholder="cooking.nytimes.com"
          placeholderTextColor={Palette.text.placeholder}
          style={[styles.urlInput, error && styles.urlInputInvalid]}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={submit}
          accessibilityLabel="Web address"
        />
        {error && <Text style={styles.errorText}>{error}</Text>}
        <View style={styles.buttonWrap}>
          <Button
            label="Open site"
            variant="primary"
            disabled={input.trim().length === 0}
            onPress={submit}
          />
        </View>

        {recent.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Your recent sites</Text>
            <View style={styles.list}>
              {recent.map((origin) => (
                <SiteRow
                  key={origin}
                  icon="clock"
                  label={siteLabel(origin)}
                  host={displayHost(origin)}
                  onPress={() => open(origin)}
                />
              ))}
            </View>
          </>
        )}

        <Text style={styles.sectionTitle}>Recipe sites</Text>
        <View style={styles.list}>
          {RECIPE_SITES.map((site) => (
            <SiteRow
              key={site.url}
              icon="globe"
              label={site.label}
              host={displayHost(site.url)}
              onPress={() => open(site.url)}
            />
          ))}
        </View>

        <Text style={styles.helperText}>
          You sign in on the site itself. Kiwi never sees your password: the sign-in stays in
          Kiwi's browser on this phone.
        </Text>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

function SiteRow({
  icon,
  label,
  host,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  host: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${label}`}
      style={({ pressed }) => [styles.siteRow, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.siteIcon}>
        <Feather name={icon} size={16} color={Colors.sage[700]} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.siteLabel}>{label}</Text>
        {host !== label && <Text style={styles.siteHost}>{host}</Text>}
      </View>
      <Feather name="chevron-right" size={18} color={Colors.neutral[600]} />
    </Pressable>
  );
}

type ImportPhase = "idle" | "reading" | "importing";

function PageBrowser({
  startUrl,
  flowParams,
  onClose,
}: {
  startUrl: string;
  flowParams: FlowParams;
  onClose: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  const [nav, setNav] = useState({ url: startUrl, canGoBack: false, canGoForward: false });
  const [phase, setPhase] = useState<ImportPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  // The tap a page answer must match; null = no tap waiting.
  const nonceRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => clearTimer, []);

  // Android's back button walks the site's own history first, then closes the
  // browser back to the site picker.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (nav.canGoBack) {
        webRef.current?.goBack();
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [nav.canGoBack, onClose]);

  const onNavigationStateChange = (s: WebViewNavigation) => {
    setNav({ url: s.url, canGoBack: s.canGoBack, canGoForward: s.canGoForward });
    if (error) setError(null);
  };

  const onShouldStartLoadWithRequest = (req: ShouldStartLoadRequest) =>
    browserAllowsNavigation(req.url);

  const handleImport = () => {
    if (phase !== "idle") return;
    setError(null);
    const nonce = newId();
    nonceRef.current = nonce;
    setPhase("reading");
    webRef.current?.injectJavaScript(pageCaptureScript(nonce));
    clearTimer();
    timerRef.current = setTimeout(() => {
      if (nonceRef.current !== nonce) return;
      nonceRef.current = null;
      setError(PAGE_CAPTURE_FAILED_MESSAGE);
      setPhase("idle");
    }, PAGE_CAPTURE_TIMEOUT_MS);
  };

  const onMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      const nonce = nonceRef.current;
      if (!nonce) return;
      const page = parsePageCaptureMessage(event.nativeEvent.data, nonce);
      if (!page) return;
      nonceRef.current = null;
      clearTimer();
      if (page.kind === "failed") {
        setError(PAGE_CAPTURE_FAILED_MESSAGE);
        setPhase("idle");
        return;
      }
      setPhase("importing");
      try {
        const result = await importRecipeFromUrl({ url: page.url, html: page.html });
        if (!result.success) {
          setError(result.userFacingMessage);
          setPhase("idle");
          return;
        }
        router.push({
          pathname: "/meal-builder",
          params: {
            draftSource: "url",
            draftJson: JSON.stringify(result.draft),
            ...flowParams,
          },
        });
        setPhase("idle");
      } catch (err) {
        setError(err instanceof Error ? err.message : PAGE_CAPTURE_FAILED_MESSAGE);
        setPhase("idle");
      }
    },
    [flowParams, router],
  );

  const busy = phase !== "idle";

  return (
    <View style={styles.bg}>
      <Header
        showBack
        onBack={onClose}
        title={displayHost(nav.url)}
        rightContent={
          <Pressable
            onPress={() => webRef.current?.reload()}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Reload page"
            style={styles.toolBtn}
          >
            <Feather name="rotate-cw" size={20} color={Colors.sage[700]} />
          </Pressable>
        }
      />
      <View style={{ flex: 1 }}>
        <WebView
          ref={webRef}
          source={{ uri: startUrl }}
          originWhitelist={["https://*", "http://*"]}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          onNavigationStateChange={onNavigationStateChange}
          onMessage={onMessage}
          // A persistent cookie jar: a sign-in survives to the next visit. The
          // WebView's own (WKWebsiteDataStore.default / Android CookieManager).
          // NOT sharedCookiesEnabled: that copies iOS cookies into the app-wide
          // NSHTTPCookieStorage, a second place a site's session would live.
          incognito={false}
          thirdPartyCookiesEnabled
          domStorageEnabled
          javaScriptEnabled
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures
          startInLoadingState
          renderLoading={() => (
            <View style={styles.webLoading}>
              <ActivityIndicator color={Colors.sage[700]} />
            </View>
          )}
        />
        {phase === "importing" && (
          <View style={styles.overlay}>
            <ActivityIndicator size="large" color={Colors.sage[700]} />
            <Text style={styles.loadingTitle}>Reading your recipe...</Text>
            <Text style={styles.loadingSubtitle}>
              Kiwi is parsing the page into structured ingredients and steps.
            </Text>
          </View>
        )}
      </View>
      <View style={[styles.bar, { paddingBottom: insets.bottom + Spacing[3] }]}>
        {error && <Text style={styles.errorText}>{error}</Text>}
        <View style={styles.barRow}>
          <Pressable
            onPress={() => webRef.current?.goBack()}
            disabled={!nav.canGoBack || busy}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Previous page"
            style={[styles.toolBtn, !nav.canGoBack && styles.toolOff]}
          >
            <Feather name="arrow-left" size={20} color={Colors.sage[700]} />
          </Pressable>
          <Pressable
            onPress={() => webRef.current?.goForward()}
            disabled={!nav.canGoForward || busy}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Next page"
            style={[styles.toolBtn, !nav.canGoForward && styles.toolOff]}
          >
            <Feather name="arrow-right" size={20} color={Colors.sage[700]} />
          </Pressable>
          <Text style={styles.barPrompt} numberOfLines={1}>
            On the recipe?
          </Text>
          <Button
            label="Import this page"
            size="sm"
            variant="primary"
            loading={busy}
            disabled={busy}
            onPress={handleImport}
            testID="import-browser-import"
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: Colors.neutral[100] },
  webOnly: { paddingHorizontal: Spacing[4], paddingTop: Spacing[5] },
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[5],
    paddingBottom: Spacing[8],
  },
  title: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[2],
  },
  subtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
    marginBottom: Spacing[5],
  },
  urlInput: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[3],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  urlInputInvalid: { borderColor: Colors.terracotta[400] },
  errorText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[2],
  },
  buttonWrap: { marginTop: Spacing[4] },
  sectionTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginTop: Spacing[6],
  },
  list: { gap: Spacing[2], marginTop: Spacing[2] },
  siteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[3],
  },
  siteIcon: {
    width: 32,
    height: 32,
    borderRadius: Radius.sm,
    backgroundColor: Colors.sage[50],
    alignItems: "center",
    justifyContent: "center",
  },
  siteLabel: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  siteHost: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  helperText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
    marginTop: Spacing[5],
  },
  toolBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  toolOff: { opacity: 0.35 },
  webLoading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.neutral[100],
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing[5],
    gap: Spacing[3],
    backgroundColor: Colors.neutral[100],
  },
  loadingTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginTop: Spacing[3],
  },
  loadingSubtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: Spacing[3],
  },
  bar: {
    backgroundColor: Palette.background.card,
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[400],
    paddingHorizontal: Spacing[3],
    paddingTop: Spacing[2],
  },
  barRow: { flexDirection: "row", alignItems: "center", gap: Spacing[1] },
  barPrompt: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginLeft: Spacing[1],
  },
});
