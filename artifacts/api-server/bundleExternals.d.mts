// Types for bundleExternals.mjs (a plain-JS module: build.mjs and the
// Dockerfile run it without tsx). Keep in step with the .mjs.

export interface BareImport {
  specifier: string;
  package: string;
  kind: "static" | "dynamic";
}

export const RUNTIME_PACKAGES: string[];
export function packageOf(specifier: string): string;
export function isBarePackageSpecifier(specifier: string): boolean;
export function bareImportsOf(source: string): BareImport[];
export function checkBundle(
  bundlePath: string,
  opts?: { resolveFrom?: string; runtimePackages?: string[] },
): { imports: BareImport[]; missing: BareImport[] };
export function formatMissing(bundlePath: string, missing: BareImport[], resolveFrom?: string): string;
