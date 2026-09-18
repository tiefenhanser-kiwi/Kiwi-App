// Types for build.mjs (plain JS; `pnpm build` runs it without tsx).

/** Build the server bundle into distDir (default: ./dist) and check its bare imports. Resolves to the bundle path. */
export function buildBundle(distDir?: string): Promise<string>;
