import crypto from "crypto";

const USERS = JSON.parse(process.env.APP_USERS_JSON || "{}");

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function basicAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme !== "Basic" || !encoded) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const [username, password] = Buffer.from(encoded, "base64").toString().split(":");
  const expected = USERS[username];

  if (!expected || !safeEqual(password || "", expected)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  req.user = username;
  next();
}