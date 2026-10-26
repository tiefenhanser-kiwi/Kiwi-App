// 1.2-NATIVE B — Sentry's Expo config wraps Expo's default: its serializer
// writes a debug id into each bundle and its source map, which is how Sentry
// matches an OTA update's crash to the map ota-update.ps1 uploads.
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

module.exports = getSentryExpoConfig(__dirname);
