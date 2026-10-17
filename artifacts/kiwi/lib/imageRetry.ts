// BOOK-1C2 (item 4a) — a remote photo that fails to load gets ONE more try.
//
// Until now a failure was terminal: TreatedImage logged it and painted the warm
// gradient for the life of the view, because nothing ever asked again (the
// source never changes, so expo-image never reloads). A Cookbook card whose
// photo failed once — a dropped request in a fling, a decode refused under
// memory pressure — stayed a gradient, while the meal's detail, a NEW view,
// loaded the same URL fine. Hans: "some cards show no image while the meal's
// detail does".
//
// One retry, after a pause, by remounting the image: enough to ride out a
// transient failure, and a URL that is really dead still settles on the
// gradient after two tries rather than hammering the bucket.

export const IMAGE_LOAD_RETRIES = 1;
export const IMAGE_RETRY_DELAY_MS = 1500;

/** The next attempt number after a failure on `attempt` (0-based), or null: give up. */
export function nextImageAttempt(attempt: number): number | null {
  return attempt < IMAGE_LOAD_RETRIES ? attempt + 1 : null;
}
