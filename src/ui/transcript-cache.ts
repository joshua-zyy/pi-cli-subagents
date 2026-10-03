import { TranscriptWindow } from "./transcript-window.js";
import { logSourceKey } from "./transcript.js";
import type { Cli } from "../types.js";

/** One viewer scope: a parent session plus one child instance and its native session identity. */
export interface TranscriptIdentity { parentFile: string; agentId: string; cli: Cli; nativeId?: string }
export interface TranscriptCacheLimits { instances?: number; entries?: number; bytes?: number }
/** Starting budget: a handful of agents, the display cap per window, and raw-window plus text bytes. */
export const TRANSCRIPT_CACHE_LIMITS: Required<TranscriptCacheLimits> = { instances: 4, entries: 1200, bytes: 8 * 1024 * 1024 };

export interface TranscriptLease {
  readonly window: TranscriptWindow;
  /** True when the window came from the cache instead of a fresh attach. */
  readonly reopened: boolean;
  /** False when the window is no longer cache-resident (detached or refused), so it will not be reused. */
  readonly cached: boolean;
  /** Unpin and stop in-flight work for this reader; the window stays cached while it fits. */
  release(): void;
}

interface CacheEntry { identity: string; files: string[]; window: TranscriptWindow; pins: number; used: number }

const identityKey = (identity: TranscriptIdentity): string =>
  `${logSourceKey(identity.parentFile)}\u0000${identity.agentId}\u0000${identity.cli}\u0000${identity.nativeId ?? ""}`;
const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((key, index) => key === b[index]);

/**
 * Process-local reuse of paged transcripts. It holds only bounded windows, never evicts the window a
 * viewer is reading, and refuses to cache a new one instead of silently exceeding its budget.
 */
export class TranscriptCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly limits: Required<TranscriptCacheLimits>;
  private clock = 0;
  private hits = 0;
  private misses = 0;
  private invalidated = 0;

  constructor(limits: TranscriptCacheLimits = {}) {
    this.limits = { instances: limits.instances ?? TRANSCRIPT_CACHE_LIMITS.instances,
      entries: limits.entries ?? TRANSCRIPT_CACHE_LIMITS.entries, bytes: limits.bytes ?? TRANSCRIPT_CACHE_LIMITS.bytes };
  }

  /** Reuse the window for this identity when the run logs are still the same list, else replace it. */
  async acquire(identity: TranscriptIdentity, files: string[], create: () => TranscriptWindow): Promise<TranscriptLease> {
    const key = identityKey(identity);
    const wanted = files.map(logSourceKey);
    let entry = this.entries.get(key);
    if (entry && !sameList(entry.files, wanted)) { this.invalidated++; this.drop(entry); entry = undefined; }
    const reopened = entry !== undefined;
    if (reopened) this.hits++; else this.misses++;
    if (!entry) {
      entry = { identity: key, files: wanted, window: create(), pins: 0, used: 0 };
      this.entries.set(key, entry);
      // Watch committed changes so the byte cap also holds while a viewer is reading, not only at release.
      entry.window.onChange = () => this.enforce(entry!);
      this.trim(entry);
      // A window that cannot fit even after evicting everything unpinned is not cached at all.
      if (this.entries.get(key) === entry && this.over()) { this.drop(entry); }
    }
    entry.pins++;
    entry.used = ++this.clock;
    let released = false;
    const cache = this;
    return {
      window: entry.window,
      reopened,
      // Live view, not an acquire-time snapshot: a detached window stops being cache-resident while readable.
      get cached(): boolean { return cache.entries.get(key) === entry; },
      release(): void {
        // Per-lease idempotence: a second release must not unpin a lease that still owns the window.
        if (released) return;
        released = true;
        entry.pins--;
        // Ownership travels with the lease, so the last close cancels even when the entry was detached.
        if (entry.pins <= 0) { entry.pins = 0; entry.window.cancel(); }
        cache.trimReleased();
      },
    };
  }

  stats(): { instances: number; entries: number; bytes: number; pinned: number; hits: number; misses: number; invalidated: number } {
    let entries = 0, bytes = 0, pinned = 0;
    for (const entry of this.entries.values()) {
      const stats = entry.window.stats();
      entries += stats.retainedEntries;
      bytes += stats.windowBytes + stats.textBytes;
      if (entry.pins > 0) pinned++;
    }
    return { instances: this.entries.size, entries, bytes, pinned, hits: this.hits, misses: this.misses, invalidated: this.invalidated };
  }
  /** Drop every cached window, for example when the parent session stops monitoring. */
  clear(): void {
    for (const entry of [...this.entries.values()]) this.drop(entry);
  }

  private drop(entry: CacheEntry): void {
    if (this.entries.get(entry.identity) === entry) this.entries.delete(entry.identity);
    entry.window.onChange = undefined;
    entry.window.dispose();
  }
  /** Detach without disposing: an active reader keeps its window, it just stops being cache-resident. */
  private detach(entry: CacheEntry): void {
    if (this.entries.get(entry.identity) !== entry) return;
    this.entries.delete(entry.identity);
    entry.window.onChange = undefined;
  }
  private over(): boolean {
    if (this.entries.size > this.limits.instances) return true;
    return this.stats().entries > this.limits.entries || this.stats().bytes > this.limits.bytes;
  }
  /** A window grew past the budget: evict idle windows first, then detach the active one if needed. */
  private enforce(active: CacheEntry): void {
    if (!this.over()) return;
    for (const entry of [...this.entries.values()].sort((a, b) => a.used - b.used)) {
      if (!this.over()) return;
      if (entry === active || entry.pins > 0) continue;
      this.drop(entry);
    }
    if (this.over()) this.detach(active);
  }
  /** Evict least-recently-used unpinned windows; the one being acquired is never the victim here. */
  private trim(keep: CacheEntry): void {
    while (this.over()) {
      const victim = [...this.entries.values()].filter(entry => entry.pins === 0 && entry !== keep).sort((a, b) => a.used - b.used)[0];
      if (!victim) return;
      this.drop(victim);
    }
  }
  /** A window can grow while it is leased, so releasing one re-checks the budget. */
  private trimReleased(): void {
    while (this.over()) {
      const victim = [...this.entries.values()].filter(entry => entry.pins === 0).sort((a, b) => a.used - b.used)[0];
      if (!victim) return;
      this.drop(victim);
    }
  }
}
