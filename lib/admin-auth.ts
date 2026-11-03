import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "micomerc-session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;

export type AdminAuthConfiguration = {
  adminEmail: string;
  adminPassword: string;
  missingVariables: string[];
};

type SessionPayload = {
  email: string;
  role: "admin";
  expiresAt: number;
};

export function getAdminAuthConfiguration(): AdminAuthConfiguration {
  const adminEmail = process.env.MICOMERC_ADMIN_EMAIL ?? "";
  const adminPassword = process.env.MICOMERC_ADMIN_PASSWORD ?? "";
  const jwtSecret = process.env.JWT_SECRET;
  const missingVariables: string[] = [];

  if (!adminEmail.trim()) missingVariables.push("MICOMERC_ADMIN_EMAIL");
  if (!adminPassword) missingVariables.push("MICOMERC_ADMIN_PASSWORD");
  if (!jwtSecret || jwtSecret.length < 32) missingVariables.push("JWT_SECRET (at least 32 characters)");

  return { adminEmail, adminPassword, missingVariables };
}

export function adminAuthConfigurationMessage(missingVariables: string[]): string {
  return `Admin sign-in is not configured on this server. Configure: ${missingVariables.join(", ")}`;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be configured with at least 32 characters");
  }
  return secret;
}

function sign(value: string): Buffer {
  return createHmac("sha256", getSecret()).update(value).digest();
}

export function createAdminSession(email: string, now = Date.now()): string {
  const payload: SessionPayload = {
    email,
    role: "admin",
    expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded).toString("base64url")}`;
}

export function readAdminSession(token: string | undefined, now = Date.now()): SessionPayload | null {
  if (!token) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return null;

  try {
    const actual = Buffer.from(signature, "base64url");
    const expected = sign(encoded);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      typeof payload !== "object" || payload === null ||
      !("email" in payload) || typeof payload.email !== "string" ||
      !("role" in payload) || payload.role !== "admin" ||
      !("expiresAt" in payload) || typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Math.floor(now / 1000)
    ) return null;

    return payload as SessionPayload;
  } catch {
    return null;
  }
}

export const ADMIN_SESSION_MAX_AGE = SESSION_TTL_SECONDS;

export function safeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHmac("sha256", "micomerc-login-compare").update(left).digest();
  const rightDigest = createHmac("sha256", "micomerc-login-compare").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
