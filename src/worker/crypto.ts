import type { RandomSource } from "../shared";

export class CryptoRandomSource implements RandomSource {
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) {
      throw new RangeError("maxExclusive must be a positive safe integer");
    }
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    const value = new Uint32Array(1);
    do {
      crypto.getRandomValues(value);
    } while (value[0] >= limit);
    return value[0] % maxExclusive;
  }
}

export function randomToken(byteCount = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteCount)));
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return encodeBase64Url(new Uint8Array(digest));
}

export function secureHashEqual(left: string, right: string): boolean {
  try {
    const leftBytes = decodeBase64Url(left);
    const rightBytes = decodeBase64Url(right);
    return leftBytes.byteLength === rightBytes.byteLength && crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

