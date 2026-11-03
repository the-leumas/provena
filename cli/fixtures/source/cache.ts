interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** A small in-memory cache that removes expired values on access. */
export class ExpiringCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  set(key: string, value: T, now: number, ttl: number): void {
    this.entries.set(key, { value, expiresAt: now + ttl });
  }

  get(key: string, now: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
}
