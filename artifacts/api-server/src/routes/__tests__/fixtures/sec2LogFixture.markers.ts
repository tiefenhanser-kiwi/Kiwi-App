// SEC-2 #12 + #15 — the distinctive strings sec2LogFixture.ts sends and
// sec2Logs.test.ts searches the child's log bytes for. A module of its own so
// the test can import them without running the fixture in-process.
export const MARKERS = {
  xff: "198.51.100.77",
  groceryTerm: "zz-private-grocery-term",
  importPath: "zz-secret-path",
  importQuery: "zz-secret-token",
  guestId: "gs-zz-guest-marker",
} as const;
