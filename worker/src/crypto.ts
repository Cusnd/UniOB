const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    return null;
  }
  const padLen = (4 - (input.length % 4)) % 4;
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  try {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export async function sha256Bytes(
  input: string | Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const data = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  return bytesToHex(await sha256Bytes(input));
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  return crypto.subtle.timingSafeEqual(hashA, hashB) && a.length === b.length;
}

export function randomBase62(length: number): string {
  // Rejection sampling to avoid modulo bias (256 - (256 % 62) = 248)
  const chars: string[] = [];
  const buf = new Uint8Array(length * 2);
  while (chars.length < length) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && chars.length < length; i++) {
      const val = buf[i]!;
      if (val < 248) {
        chars.push(BASE62_ALPHABET[val % 62]!);
      }
    }
  }
  return chars.join("");
}

export function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${randomBase62(12)}`;
}

export function generateAgentToken(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  let num = 0n;
  for (let i = 0; i < raw.length; i++) {
    num = (num << 8n) | BigInt(raw[i]!);
  }
  const chars = new Array<string>(43).fill("0");
  for (let i = 42; i >= 0; i--) {
    const rem = Number(num % 62n);
    chars[i] = BASE62_ALPHABET[rem]!;
    num /= 62n;
  }
  return `uob_live_${chars.join("")}`;
}

export function generateRandomSecret(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

const PBKDF2_ITERATIONS = 100_000;

export async function hashPasswordPBKDF2(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(derived))}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const trimmed = storedHash.trim();
  if (trimmed.startsWith("pbkdf2$")) {
    const parts = trimmed.split("$");
    if (parts.length !== 4) {
      return false;
    }
    const iterations = Number.parseInt(parts[1]!, 10);
    const salt = hexToBytes(parts[2]!);
    const expectedHex = parts[3]!.toLowerCase();
    if (
      !Number.isFinite(iterations) ||
      iterations < 1 ||
      iterations > 100_000 ||
      !salt ||
      !/^[0-9a-f]{64}$/.test(expectedHex)
    ) {
      return false;
    }
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const derived = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations,
      },
      keyMaterial,
      256,
    );
    const computedHex = bytesToHex(new Uint8Array(derived));
    return constantTimeEqual(computedHex, expectedHex);
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const computedHex = await sha256Hex(password);
    return constantTimeEqual(computedHex, trimmed.toLowerCase());
  }

  return false;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function hmacSha256Hex(
  message: string,
  secret: string,
): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

export async function signSessionToken(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  return `${payloadB64}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | null> {
  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0 || dotIdx !== token.lastIndexOf(".")) {
    return null;
  }
  const payloadB64 = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);
  const sigBytes = base64UrlDecode(sigB64);
  if (!sigBytes) {
    return null;
  }

  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    encoder.encode(payloadB64),
  );
  if (!valid) {
    return null;
  }

  const payloadBytes = base64UrlDecode(payloadB64);
  if (!payloadBytes) {
    return null;
  }

  try {
    const parsed = JSON.parse(decoder.decode(payloadBytes)) as Partial<SessionPayload>;
    if (
      typeof parsed.sub !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number" ||
      parsed.exp <= nowSec
    ) {
      return null;
    }
    return {
      sub: parsed.sub,
      iat: parsed.iat,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}
