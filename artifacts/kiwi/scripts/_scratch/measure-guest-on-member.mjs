// SCRATCH (Row 13 Block 2 Part A) — what does a GUEST token get back from a
// requireAuth route? Measured at the seam that decides it, with no server and
// no database: requireAuth calls verifyToken(token, "session") and returns
// 401 the moment that yields null, BEFORE readTokensValidFrom touches Prisma.
// So the verdict is decided by the purpose check alone.
import { createRequire } from "node:module";
const jwt = createRequire("C:/Cooking App/Kiwi-App/artifacts/api-server/package.json")("jsonwebtoken");

const SECRET = "scratch-secret-not-a-real-key";

function signToken(userId, purpose) {
  return jwt.sign({ userId, purpose }, SECRET, {
    expiresIn: purpose === "guest" ? "24h" : "30d",
    jwtid: "scratch-jti",
  });
}

// src/lib/auth.ts verifyToken, transcribed.
function verifyToken(token, expectedPurpose) {
  try {
    const decoded = jwt.verify(token, SECRET);
    if (!decoded.userId) return null;
    const purpose = decoded.purpose ?? "session";
    if (expectedPurpose && purpose !== expectedPurpose) return null;
    return { ...decoded, purpose };
  } catch {
    return null;
  }
}

const guestToken = signToken("gs_abc123", "guest");
const sessionToken = signToken("u_abc123", "session");

const rows = [
  ["guest token  → requireAuth (expects 'session')", verifyToken(guestToken, "session")],
  ["guest token  → requireGuestOrAuth (tries 'guest' first)", verifyToken(guestToken, "guest")],
  ["session token → requireGuestOrAuth guest probe", verifyToken(sessionToken, "guest")],
  ["session token → requireAuth", verifyToken(sessionToken, "session")],
];

for (const [label, payload] of rows) {
  const verdict =
    payload === null
      ? "null  → guard rejects"
      : `ok (userId=${payload.userId})`;
  console.log(`${label.padEnd(56)} ${verdict}`);
}

console.log("");
console.log(
  "requireAuth on a null payload: res.status(401).json({ error: 'invalid or expired token' })",
);
console.log("There is no 403 branch anywhere in middleware/auth.ts.");
