// 1.2-NATIVE B — crash reporting is off on web (the web CSP pins connect-src,
// and a browser has its own console). The web twin of lib/sentry.ts, so the
// web bundle never loads @sentry/react-native.

export function initCrashReporting(): void {}

export async function setCrashUser(_userId: string | null): Promise<void> {}

export function reportBoundaryError(_error: Error): void {}
