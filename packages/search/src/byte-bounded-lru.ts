export const PRIVATE_RAG_CACHE_TTL_MS = 5 * 60 * 1000;

export type ByteBoundedLruOptions<Value> = Readonly<{
  maxBytes: number;
  ttlMs?: number;
  now?: () => number;
  dispose?: (value: Value) => void;
}>;

type CacheEntry<Value> = Readonly<{
  value: Value;
  sizeBytes: number;
  expiresAt: number;
}>;

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name}_must_be_a_positive_safe_integer`);
  }
}

export class ByteBoundedLruCache<Key, Value> {
  readonly maxBytes: number;
  readonly ttlMs: number;

  readonly #entries = new Map<Key, CacheEntry<Value>>();
  readonly #now: () => number;
  readonly #dispose: ((value: Value) => void) | undefined;
  #currentBytes = 0;

  constructor(options: ByteBoundedLruOptions<Value>) {
    assertPositiveSafeInteger(options.maxBytes, "max_bytes");
    const ttlMs = options.ttlMs ?? PRIVATE_RAG_CACHE_TTL_MS;
    assertPositiveSafeInteger(ttlMs, "ttl_ms");
    if (ttlMs > PRIVATE_RAG_CACHE_TTL_MS) {
      throw new RangeError("ttl_ms_exceeds_private_rag_maximum");
    }
    this.maxBytes = options.maxBytes;
    this.ttlMs = ttlMs;
    this.#now = options.now ?? Date.now;
    this.#dispose = options.dispose;
  }

  get size(): number {
    return this.#entries.size;
  }

  get currentBytes(): number {
    return this.#currentBytes;
  }

  get(key: Key): Value | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#remove(key, entry);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: Key, value: Value, sizeBytes: number): boolean {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new RangeError("size_bytes_must_be_a_non_negative_safe_integer");
    }
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (existing.value === value) {
        this.#entries.delete(key);
        this.#currentBytes -= existing.sizeBytes;
      } else {
        this.#remove(key, existing);
      }
    }

    if (sizeBytes > this.maxBytes) return false;
    while (this.#currentBytes + sizeBytes > this.maxBytes) {
      const oldest = this.#entries.entries().next().value as
        readonly [Key, CacheEntry<Value>] | undefined;
      if (oldest === undefined) break;
      this.#remove(oldest[0], oldest[1]);
    }

    this.#entries.set(key, {
      value,
      sizeBytes,
      expiresAt: this.#now() + this.ttlMs
    });
    this.#currentBytes += sizeBytes;
    return true;
  }

  delete(key: Key): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#remove(key, entry);
    return true;
  }

  deleteWhere(predicate: (value: Value, key: Key) => boolean): number {
    let deleted = 0;
    for (const [key, entry] of [...this.#entries.entries()]) {
      if (predicate(entry.value, key)) {
        this.#remove(key, entry);
        deleted += 1;
      }
    }
    return deleted;
  }

  pruneExpired(): number {
    const now = this.#now();
    return this.deleteWhere((_value, key) => {
      const entry = this.#entries.get(key);
      return entry !== undefined && entry.expiresAt <= now;
    });
  }

  clear(): void {
    for (const [key, entry] of [...this.#entries.entries()]) {
      this.#remove(key, entry);
    }
  }

  #remove(key: Key, entry: CacheEntry<Value>): void {
    if (!this.#entries.delete(key)) return;
    this.#currentBytes -= entry.sizeBytes;
    this.#dispose?.(entry.value);
  }
}
