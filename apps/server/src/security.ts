import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Rng } from '@zhol/engine';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@zhol/protocol';

/** Cryptographically secure RNG for production dealing. */
export const secureRng: Rng = {
  int(maxExclusive: number) {
    return randomInt(maxExclusive);
  },
};

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

/** 256-bit opaque seat credential. Only its SHA-256 hash is stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Fixed-window-free token bucket keyed by an arbitrary string (IP, socket id…). */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  constructor(
    private capacity: number,
    private refillPerSecond: number,
  ) {}

  take(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.updated) / 1000) * this.refillPerSecond);
    b.updated = now;
    if (this.buckets.size > 50_000) this.prune(now);
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }

  private prune(now: number) {
    for (const [k, v] of this.buckets) if (now - v.updated > 10 * 60_000) this.buckets.delete(k);
  }
}

/** Short-lived in-memory cache for create/join retries (responses contain credentials, so not persisted). */
export class TtlCache<V> {
  private map = new Map<string, { value: V; expires: number }>();
  constructor(private ttlMs: number) {}
  get(key: string, now = Date.now()): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < now) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: V, now = Date.now()) {
    if (this.map.size > 10_000) for (const [k, v] of this.map) if (v.expires < now) this.map.delete(k);
    this.map.set(key, { value, expires: now + this.ttlMs });
  }
}
