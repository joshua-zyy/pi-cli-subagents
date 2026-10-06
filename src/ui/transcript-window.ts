import { open, stat } from "node:fs/promises";
import { TranscriptReader, logSourceKey } from "./transcript.js";
import type { TranscriptEntry, TranscriptPageBoundary, TranscriptPosition, TranscriptSnapshot, TranscriptUsage } from "./transcript.js";
import type { Cli } from "../types.js";

/** Bytes of older history read per page step. */
export const WINDOW_PAGE_BYTES = 512 * 1024;
/** Entries the window advances per page step; a full window still means every record stays reachable. */
export const WINDOW_STEP_ENTRIES = 150;
/** Displayed entries per window; the existing viewer contract keeps 300. */
export const WINDOW_MAX_ENTRIES = 300;
/** One window must hold a legal record plus its newline, so it is never split below that. */
export const WINDOW_MAX_BYTES = 4 * 1024 * 1024 + WINDOW_PAGE_BYTES;
/** Retained transcript text per window. */
export const WINDOW_TEXT_BYTES = 4 * 1024 * 1024;
/** Bound for a native-identity scan at the head of a run. */
export const WINDOW_HEAD_BYTES = 512 * 1024;
/** Backward scan chunk for record boundaries. */
export const WINDOW_SCAN_BYTES = 64 * 1024;
/** Per-step search budget, so boundary lookups cannot become a full-history scan. */
export const WINDOW_SEARCH_BYTES = WINDOW_MAX_BYTES + WINDOW_PAGE_BYTES;
/** Safety cap for one range parse; the window trims to its own budget right after. */
export const WINDOW_READER_ENTRIES = 2000;
/** Bytes kept to notice a rewrite that also grew the file. */
export const WINDOW_SAMPLE_BYTES = 64;

export interface TranscriptWindowOptions {
  /** Bytes of tail read on the first frame; defaults to one page. */
  initialBytes?: number;
  pageBytes?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxTextBytes?: number;
}

interface SourceState { key: string; path: string; size: number; exists: boolean; ino: number; dev: number; mtimeMs: number; ctimeMs: number }

type Keep = { kind: "newest" } | { kind: "oldest" } | { kind: "step-up"; anchor?: string; step: number } | { kind: "step-down"; anchor?: string; step: number };

/** Thrown at cancellation checkpoints so no further I/O starts and no partial state is committed. */
class Cancelled extends Error {}

const samePosition = (a: TranscriptPosition | undefined, b: TranscriptPosition | undefined): boolean =>
  a !== undefined && b !== undefined && a.source === b.source && a.offset === b.offset;
const lastReadable = (sources: SourceState[]): number => {
  for (let i = sources.length - 1; i >= 0; i--) if (sources[i].exists && sources[i].size > 0) return i;
  return -1;
};
/** Move a stream position back by up to `bytes`, across the run boundary. */
function stepBack(sources: SourceState[], position: TranscriptPosition, bytes: number): TranscriptPosition {
  let index = sources.findIndex(source => source.key === position.source);
  if (index < 0) return position;
  let offset = position.offset, remaining = bytes;
  while (index > 0 && remaining > offset) { remaining -= offset + 1; index--; offset = sources[index].size; }
  if (remaining <= offset) offset -= remaining; else offset = 0;
  return { source: sources[index].key, offset: Math.max(0, offset) };
}
/** Move a stream position forward by up to `bytes`, across the run boundary. */
function stepForward(sources: SourceState[], position: TranscriptPosition, bytes: number): TranscriptPosition {
  let index = sources.findIndex(source => source.key === position.source);
  if (index < 0) return position;
  let offset = position.offset, remaining = bytes;
  while (index < sources.length - 1 && remaining > sources[index].size - offset) {
    remaining -= sources[index].size - offset + 1; index++; offset = 0;
  }
  offset = Math.min(sources[index].size, offset + remaining);
  return { source: sources[index].key, offset };
}
function streamDistance(sources: SourceState[], from: TranscriptPosition, to: TranscriptPosition): number {
  const start = sources.findIndex(source => source.key === from.source);
  const end = sources.findIndex(source => source.key === to.source);
  if (start < 0 || end < 0 || end < start) return Number.POSITIVE_INFINITY;
  if (start === end) return to.offset - from.offset;
  let total = sources[start].size - from.offset;
  for (let i = start + 1; i < end; i++) total += sources[i].size;
  return total + to.offset;
}

/**
 * A bounded, contiguous byte window over the child's run logs. It reads a tail first and only
 * extends when the reader asks for a page, so unprompted history scans cannot happen.
 */
export class TranscriptWindow {
  private readonly cli: Cli;
  private readonly initialBytes: number;
  private readonly pageBytes: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxText: number;
  private threadId?: string;
  private sources: SourceState[] = [];
  private reader?: TranscriptReader;
  private entries: TranscriptEntry[] = [];
  private from?: TranscriptPosition;
  private to?: TranscriptPosition;
  private atStart = true;
  private atEnd = true;
  private tailTrimmed = false;
  /** The window end is anchored at the live EOF, so appended bytes keep being read even mid-catch-up. */
  private live = false;
  /** Raw consumption cursor of the parser, including a partially buffered record. */
  private cursor?: TranscriptPosition;
  private loading = false;
  private parsedWhole = false;
  private usage?: TranscriptUsage;
  private provider?: string;
  private model?: string;
  private notice?: string;
  /** Non-fatal reason the window cannot claim native records yet; it survives page rebuilds. */
  private identityNotice?: string;
  private revision = 0;
  private sourceEpoch = 0;
  private outputRevision = 0;
  private tailSample?: { source: string; offset: number; bytes: Buffer };
  private readBytes = 0;
  private readCalls = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;

  constructor(cli: Cli = "pi", threadId?: string, options: TranscriptWindowOptions = {}) {
    this.cli = cli;
    this.threadId = threadId;
    this.pageBytes = options.pageBytes ?? WINDOW_PAGE_BYTES;
    this.initialBytes = options.initialBytes ?? this.pageBytes;
    this.maxEntries = options.maxEntries ?? WINDOW_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? WINDOW_MAX_BYTES;
    this.maxText = options.maxTextBytes ?? WINDOW_TEXT_BYTES;
  }

  /** Attach to the run logs at a bounded tail, or read only the bytes appended since the last call. */
  open(files: string[]): Promise<TranscriptSnapshot> { return this.run(() => this.openNow(files)); }
  /** The same work without the queue, for callers that already hold the queue task. */
  private async openNow(files: string[]): Promise<TranscriptSnapshot> {
    if (!files.length) { this.resetState(); return this.snapshot(); }
    const grown = this.sources.length > 0 && files.length >= this.sources.length
      && this.sources.every((source, index) => source.key === logSourceKey(files[index]));
    return grown ? this.refresh(files) : this.attach(files);
  }
  /** One bounded step towards older records. */
  pageUp(files: string[], boundary?: TranscriptPageBoundary): Promise<TranscriptSnapshot> { return this.run(() => this.page(files, -1, boundary)); }
  /** One bounded step towards newer records, restoring entries a page-up evicted. */
  pageDown(files: string[], boundary?: TranscriptPageBoundary): Promise<TranscriptSnapshot> { return this.run(() => this.page(files, 1, boundary)); }
  /** Explicitly re-anchor at the live end; the only operation that abandons the current window. */
  toTail(files: string[]): Promise<TranscriptSnapshot> {
    return this.run(async () => {
      if (!files.length) return this.snapshot();
      const sources = await this.statAll(files);
      this.checkCancelled();
      if (this.invalidAgainst(sources)) return this.attach(files);
      this.sources = sources;
      const index = lastReadable(sources);
      if (index < 0) return this.snapshot();
      const liveEnd = { source: sources[index].key, offset: sources[index].size };
      if (this.atEnd && this.to !== undefined) return this.refresh(files);
      await this.replayTail(files, liveEnd, this.pageBytes);
      return this.snapshot();
    });
  }
  /** Real I/O, retained bytes and window bounds for bounded-work checks and the cache budget. Retained
   * figures count what the parser really keeps (its entry store), not only the displayed window. */
  stats(): { from?: TranscriptPosition; to?: TranscriptPosition; atStart: boolean; atEnd: boolean; entries: number; retainedEntries: number; windowBytes: number; textBytes: number; readBytes: number; readCalls: number } {
    const retained = this.reader?.stats();
    return { ...(this.from ? { from: { ...this.from } } : {}), ...(this.to ? { to: { ...this.to } } : {}),
      atStart: this.atStart, atEnd: this.atEnd, entries: this.entries.length,
      retainedEntries: retained?.entries ?? this.entries.length,
      windowBytes: this.from && this.to ? streamDistance(this.sources, this.from, this.to) : 0,
      textBytes: retained?.textBytes ?? textBytes(this.entries), readBytes: this.readBytes, readCalls: this.readCalls };
  }
  /** Stop queued and in-flight work at the next checkpoint while keeping the parsed window cached. */
  cancel(): void { this.generation++; }
  /** Drop parsed state and stop work; a later open re-attaches at the tail. */
  dispose(): void { this.generation++; this.resetState(); }
  /** Hook for the cache: called after every committed window change, never on cancellation. */
  onChange?: () => void;

  private taskGeneration = -1;
  private cancelled(): boolean { return this.taskGeneration >= 0 && this.taskGeneration !== this.generation; }
  private checkCancelled(): void { if (this.cancelled()) throw new Cancelled(); }

  /** Serial calls only: a queued page never interleaves with a live refresh, and a closed window stops. */
  private run(task: () => Promise<TranscriptSnapshot>): Promise<TranscriptSnapshot> {
    const generation = this.generation;
    const start = async (): Promise<TranscriptSnapshot> => {
      if (generation !== this.generation) return this.snapshot();
      this.taskGeneration = generation;
      try {
        const result = await task();
        this.checkCancelled();
        return result;
      } catch (error) {
        if (error instanceof Cancelled) return this.snapshot();
        throw error;
      } finally { this.taskGeneration = -1; }
    };
    const next = this.queue.then(start, start);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private resetState(): void {
    this.sourceEpoch++;
    this.sources = []; this.reader = undefined; this.entries = [];
    this.from = undefined; this.to = undefined; this.cursor = undefined;
    this.atStart = true; this.atEnd = true; this.tailTrimmed = false; this.live = false; this.loading = false;
    this.parsedWhole = false; this.usage = undefined; this.provider = undefined; this.model = undefined;
    this.notice = undefined; this.tailSample = undefined;
  }

  private async statAll(files: string[]): Promise<SourceState[]> {
    const sources: SourceState[] = [];
    for (const file of files) {
      const key = logSourceKey(file);
      try {
        const info = await stat(file);
        this.checkCancelled();
        sources.push({ key, path: file, size: info.size, exists: true, ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
      } catch (error) {
        // A closed page is not a missing file: cancellation must never be folded into a reset.
        if (error instanceof Cancelled) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        sources.push({ key, path: file, size: 0, exists: false, ino: 0, dev: 0, mtimeMs: 0, ctimeMs: 0 });
      }
    }
    return sources;
  }
  /** Conservative file identity: shrink, replacement or a same-size rewrite invalidates parsed bytes. */
  private invalidAgainst(sources: SourceState[]): boolean {
    if (!this.sources.length) return false;
    if (sources.length < this.sources.length) return true;
    for (const previous of this.sources) {
      const current = sources.find(source => source.key === previous.key);
      if (!current) return true;
      // A run log that never existed is normal (the newest run is created late); only losing one matters.
      if (!previous.exists) continue;
      if (!current.exists) return true;
      if (current.ino !== previous.ino || current.dev !== previous.dev) return true;
      if (current.size < previous.size) return true;
      if (current.size === previous.size && (current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs)) return true;
    }
    return false;
  }

  private async attach(files: string[]): Promise<TranscriptSnapshot> {
    const sources = await this.statAll(files);
    this.checkCancelled();
    // Failed or cancelled metadata checks must not discard the previously published window.
    this.resetState();
    this.sources = sources;
    const index = lastReadable(sources);
    if (index < 0) { this.notice = "Event log unavailable: the run logs do not exist yet."; return this.snapshot(); }
    const live = sources[index];
    if (this.cli !== "pi" && !this.threadId) await this.learnIdentity(live);
    const liveEnd = { source: live.key, offset: live.size };
    await this.replayTail(files, liveEnd, this.initialBytes);
    return this.snapshot();
  }

  /** Control events (notably Pi's aggregate agent_end) can fill the tail without any displayable
   * messages. Expand once within the existing window budget, never on idle refreshes. */
  private async replayTail(files: string[], end: TranscriptPosition, bytes: number): Promise<void> {
    const range = await this.planRange(this.sources, stepBack(this.sources, end, bytes), end, "head");
    await this.replay(files, range, { kind: "newest" });
    if (this.atStart || this.entries.some(entry => entry.kind !== "assistant" || entry.text)) return;
    const expanded = await this.planRange(this.sources, stepBack(this.sources, end, this.maxBytes), end, "head");
    if (!samePosition(expanded.from, range.from)) await this.replay(files, expanded, { kind: "newest" });
    if (!this.atStart && !this.entries.some(entry => entry.kind !== "assistant" || entry.text)) {
      this.notice = [this.notice, "No displayable messages in the recent window; Page Up to search older history."].filter(Boolean).join(" ");
    }
  }

  private async refresh(files: string[]): Promise<TranscriptSnapshot> {
    const sources = await this.statAll(files);
    // Nothing is committed for a closed page, so the cached transcript survives untouched.
    this.checkCancelled();
    const previous = this.sources;
    if (this.invalidAgainst(sources)) return this.attach(files);
    this.sources = sources;
    const index = lastReadable(sources);
    if (index < 0) return this.snapshot();
    // Cancel or dispose can leave a window without state; an ordinary open must re-attach by itself.
    if (!this.reader || !this.to || !this.from) return this.attach(files);
    const live = sources[index];
    const liveEnd = { source: live.key, offset: live.size };
    // "Following the live end" is the read intent; still being behind EOF only means more calls are needed.
    if (!this.live) return this.snapshot();
    if (await this.rewrittenBeforeTail(live, previous)) return this.attach(files);
    const reader = this.reader;
    const before = reader.stats();
    const parseFrom = this.from, resume = this.cursor ?? this.to;
    // Resume from the raw cursor so buffered UTF-8/LF fragments are neither dropped nor read twice.
    let snapshot: TranscriptSnapshot;
    try {
      snapshot = await reader.readRange(files, resume, liveEnd,
        { append: true, budget: this.pageBytes, cancelled: () => this.cancelled() });
    } finally {
      // The parser owns the true raw consumption cursor; adopting it even on a cancelled call keeps a
      // reopen from rewinding into bytes already consumed (which would replay records and double usage).
      this.cursor = reader.cursor;
    }
    const consumed = this.account(reader, before);
    this.checkCancelled();
    this.reader = reader;
    this.cursor = reader.cursor;
    this.apply(snapshot, this.retain(snapshot.entries, { kind: "newest" }), { from: parseFrom, to: liveEnd, truncated: false, fragment: false });
    if (consumed > 0) { this.revision++; this.outputRevision++; await this.captureSample(); }
    return this.snapshot();
  }

  private async page(files: string[], direction: -1 | 1, boundary?: TranscriptPageBoundary): Promise<TranscriptSnapshot> {
    // Never call the queued entry point here: this runs inside the queue already.
    if (!this.reader || !this.from || !this.to) return this.openNow(files);
    const sources = await this.statAll(files);
    this.checkCancelled();
    if (this.invalidAgainst(sources)) return this.attach(files);
    this.sources = sources;
    const index = lastReadable(sources);
    if (index < 0) return this.snapshot();
    const sameEdge = !boundary || samePosition(boundary.position, direction < 0 ? this.from : this.to);
    if (sameEdge && direction > 0 && this.live) return this.snapshot();
    if (sameEdge && direction < 0 && this.atStart) return this.snapshot();
    // The displayed edge can outlive this reader's last page. Seek directly to it, rather than
    // replaying all intervening cached pages just to restore the disk cursor.
    const forward = sameEdge && !this.tailTrimmed && this.cursor && streamDistance(sources, boundary?.position ?? this.to, this.cursor) > 0
      ? this.cursor : boundary?.position ?? this.to;
    const step = boundary
      ? direction < 0
        ? await this.planRange(sources, stepBack(sources, boundary.position, this.pageBytes), boundary.position, "head")
        : await this.planRange(sources, boundary.position, stepForward(sources, forward, this.pageBytes), "head")
      : direction < 0
        ? await this.planRange(sources, stepBack(sources, this.from, this.pageBytes), this.to, "tail")
        : await this.planRange(sources, this.from, stepForward(sources, this.to, this.pageBytes), "head");
    const keep: Keep = boundary ? { kind: direction < 0 ? "newest" : "oldest" } : direction < 0
      ? { kind: "step-up", anchor: this.entries[0]?.id, step: WINDOW_STEP_ENTRIES }
      : { kind: "step-down", anchor: this.entries.at(-1)?.id, step: WINDOW_STEP_ENTRIES };
    await this.replay(files, step, keep);
    return this.snapshot();
  }

  /** Fresh contiguous replay of one planned range; every entry is rebuilt, never merged. */
  private async replay(files: string[], range: { from: TranscriptPosition; to: TranscriptPosition; truncated: boolean; fragment: boolean }, keep: Keep): Promise<void> {
    const reader = this.newReader();
    const before = reader.stats();
    const snapshot = await reader.readRange(files, range.from, range.to, { fragmentStart: range.fragment, keepOldest: keep.kind === "oldest", cancelled: () => this.cancelled() });
    this.account(reader, before);
    // Commit only when the page is still open: a closed window keeps its last published state.
    this.checkCancelled();
    this.reader = reader;
    this.cursor = reader.cursor;
    this.apply(snapshot, this.retain(snapshot.entries, keep), range);
    this.revision++;
    await this.captureSample();
  }

  /** Publish one parsed range as the window: bounds, identity, totals and fragment markers. */
  private apply(snapshot: TranscriptSnapshot, selected: TranscriptEntry[], range: { from: TranscriptPosition; to: TranscriptPosition; truncated: boolean; fragment: boolean }): void {
    this.checkCancelled();
    const sources = this.sources;
    const liveIndex = lastReadable(sources);
    const liveEnd = liveIndex >= 0 ? { source: sources[liveIndex].key, offset: sources[liveIndex].size } : range.to;
    const parsed = snapshot.entries;
    const parseFrom = range.from, requestedEnd = range.to;
    const parseEnd = snapshot.window?.to ?? requestedEnd;
    const reachedEnd = !snapshot.loading;
    const stats = this.reader!.stats();
    // A clamped window starts inside a record: entries it cuts are explicit head fragments, never silent.
    const startsEarlier = (entry: TranscriptEntry): boolean => entry.span !== undefined && streamDistance(sources, entry.span.start, parseFrom) === Number.POSITIVE_INFINITY;
    const clipped = selected.some(startsEarlier) ? selected.map(entry => startsEarlier(entry) ? { ...entry, partial: entry.partial ?? "head" as const } : entry) : selected;
    // A group still open at the parse end is marked: the byte budget may have cut it, and a range may too.
    this.entries = markTail(clipped, parsed, reachedEnd ? stats.tailContinues : !samePosition(parseEnd, liveEnd));
    // Coverage is the parsed range; only entries actually dropped from an edge move the bound inwards.
    // Identity, not object equality: fragment marking copies entries without changing their ids.
    const headTrimmed = clipped.length > 0 && parsed.length > 0 && clipped[0].id !== parsed[0].id;
    const tailTrimmed = clipped.length > 0 && parsed.length > 0 && clipped[clipped.length - 1].id !== parsed[parsed.length - 1].id;
    this.tailTrimmed = tailTrimmed;
    this.from = headTrimmed ? clipped[0].span!.start : parseFrom;
    this.to = tailTrimmed ? clipped[clipped.length - 1].span!.end : parseEnd;
    this.atStart = samePosition(parseFrom, this.logStart()) && !headTrimmed;
    // An unfinished trailing record leaves `parseEnd` just short of the live end; the parse still reached it.
    const askedLiveEnd = samePosition(requestedEnd, liveEnd) || (requestedEnd.source === liveEnd.source && requestedEnd.offset >= liveEnd.offset);
    // `live` is the read intent; `atEnd` still reports whether the parse really caught up with EOF.
    this.live = askedLiveEnd && !tailTrimmed;
    this.atEnd = reachedEnd && this.live;
    this.loading = snapshot.loading;
    this.provider = snapshot.provider; this.model = snapshot.model;
    this.notice = [snapshot.notice, this.identityNotice, (range.truncated || range.fragment) && !snapshot.notice ? "Showing recent content only; older or oversized content remains in the event logs." : undefined]
      .filter(Boolean).join(" ") || undefined;
    // Whole-log totals are published only when this parse covered every run without skipping records.
    this.parsedWhole = samePosition(parseFrom, this.logStart()) && askedLiveEnd && reachedEnd
      && !stats.clipped && !stats.malformed && !stats.unavailable;
    this.usage = this.parsedWhole ? snapshot.usage : undefined;
    this.onChange?.();
  }

  /** Trim a parsed range down to one window, dropping from the edge the reader is moving away from. */
  private retain(parsed: TranscriptEntry[], keep: Keep): TranscriptEntry[] {
    let selected: TranscriptEntry[];
    if (keep.kind === "newest") selected = parsed.slice(Math.max(0, parsed.length - this.maxEntries));
    else if (keep.kind === "oldest") selected = parsed.slice(0, this.maxEntries);
    else if (keep.kind === "step-up") {
      const index = keep.anchor === undefined ? -1 : parsed.findIndex(entry => entry.id === keep.anchor);
      const base = index < 0 ? parsed.length : index;
      const start = Math.max(0, base - keep.step);
      selected = parsed.slice(start, start + this.maxEntries);
    } else {
      let index = -1;
      if (keep.anchor !== undefined) for (let i = parsed.length - 1; i >= 0; i--) if (parsed[i].id === keep.anchor) { index = i; break; }
      const end = index < 0 ? 0 : Math.min(parsed.length, index + 1 + keep.step);
      selected = parsed.slice(Math.max(0, end - this.maxEntries), end);
    }
    const dropFromFront = keep.kind === "newest" || keep.kind === "step-down";
    while (selected.length > 1 && (streamDistance(this.sources, selected[0].span!.start, selected[selected.length - 1].span!.end) > this.maxBytes || textBytes(selected) > this.maxText)) {
      selected = dropFromFront ? selected.slice(1) : selected.slice(0, -1);
    }
    return selected;
  }
  /** Every build starts from a fresh reader so no state can leak between ranges. */
  private newReader(): TranscriptReader {
    // Paged replays never adopt a native identity from their own records; only the head read may.
    return new TranscriptReader(this.cli, this.threadId, { keys: "position", maxEntries: WINDOW_READER_ENTRIES, adoptIdentity: false });
  }
  private account(reader: TranscriptReader, before: { readBytes: number; readCalls: number }): number {
    const after = reader.stats();
    this.readBytes += after.readBytes - before.readBytes;
    this.readCalls += after.readCalls - before.readCalls;
    return after.readBytes - before.readBytes;
  }

  /** The head-mounted identity read is the only discovery source a window trusts. */
  private async learnIdentity(source: SourceState): Promise<void> {
    const limit = Math.min(source.size, WINDOW_HEAD_BYTES);
    if (limit <= 0) return;
    const reader = new TranscriptReader(this.cli, undefined, { keys: "position", maxEntries: 64 });
    const before = reader.stats();
    await reader.readRange([source.path], { source: source.key, offset: 0 }, { source: source.key, offset: limit });
    this.account(reader, before);
    this.checkCancelled();
    if (reader.nativeId) {
      this.threadId = reader.nativeId;
      this.identityNotice = undefined;
    } else this.identityNotice = "Waiting for the native session identity while history loads.";
  }

  private logStart(): TranscriptPosition {
    const first = this.sources[0];
    return { source: first ? first.key : this.from?.source ?? "", offset: 0 };
  }
  private sourceOf(position: TranscriptPosition): SourceState | undefined {
    return this.sources.find(source => source.key === position.source);
  }
  /** Read a byte range of one run log; every window read goes through here so I/O stays accountable. */
  private async readBytesAt(source: SourceState, from: number, to: number): Promise<Buffer> {
    const start = Math.max(0, Math.min(from, source.size));
    const length = Math.max(0, Math.min(to, source.size) - start);
    if (length <= 0) return Buffer.alloc(0);
    this.checkCancelled();
    const handle = await open(source.path, "r");
    try {
      this.checkCancelled();
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, start);
      this.readCalls++;
      this.readBytes += bytesRead;
      // The submitted read may finish; nothing further may start for a closed page.
      this.checkCancelled();
      return bytes.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }
  /** Latest record boundary at or before `offset`, or undefined when only a fragment precedes `floor`. */
  private async lineStart(source: SourceState, offset: number, floor: number, budget: { left: number }): Promise<number | undefined> {
    let end = Math.min(offset, source.size);
    while (end > floor && budget.left > 0) {
      const start = Math.max(floor, end - WINDOW_SCAN_BYTES);
      const bytes = await this.readWithin(source, start, end, budget);
      const index = bytes.lastIndexOf(10);
      if (index >= 0) return start + index + 1;
      end = start;
    }
    return undefined;
  }
  /** One budgeted window read: scans and replays share one physical I/O allowance that is really enforced. */
  private async readWithin(source: SourceState, from: number, to: number, budget: { left: number }): Promise<Buffer> {
    if (budget.left <= 0) return Buffer.alloc(0);
    const before = this.readBytes;
    const bytes = await this.readBytesAt(source, from, Math.min(to, from + budget.left));
    budget.left -= this.readBytes - before;
    return bytes;
  }
  /**
   * Latest record boundary at or before `target`, never before `floor`: one bounded backward scan per run
   * file instead of per-candidate I/O. A run log starts on a record boundary, so offset zero is a legal
   * boundary and is never skipped as a fragment.
   */
  private async safeStart(sources: SourceState[], target: TranscriptPosition, floor: TranscriptPosition): Promise<{ from: TranscriptPosition; truncated: boolean; boundary: boolean }> {
    const budget = { left: WINDOW_SEARCH_BYTES };
    const targetIndex = sources.findIndex(source => source.key === target.source);
    const floorIndex = sources.findIndex(source => source.key === floor.source);
    for (let index = targetIndex < 0 ? sources.length - 1 : targetIndex; index >= 0; index--) {
      this.checkCancelled();
      const source = sources[index];
      if (!source.exists || source.size === 0) continue;
      const floorHere = index === floorIndex ? Math.min(floor.offset, source.size) : 0;
      const end = source.key === target.source ? Math.min(target.offset, source.size) : source.size;
      if (end > floorHere) {
        const found = await this.lineStart(source, end, floorHere, budget);
        if (found !== undefined) return { from: { source: source.key, offset: found }, truncated: false, boundary: true };
      }
      // The floor itself is a fragment start: the caller clips it instead of scanning further forward.
      if (floorHere > 0 || budget.left <= 0) break;
      return { from: { source: source.key, offset: 0 }, truncated: !samePosition({ source: source.key, offset: 0 }, this.logStart()), boundary: true };
    }
    return { from: floor, truncated: true, boundary: false };
  }
  /**
   * One replay range: a record boundary inside the search budget, hard-limited to the window byte budget by
   * cutting the end the reader is moving away from. `drop` names the end that may be cut.
   */
  private async planRange(sources: SourceState[], target: TranscriptPosition, end: TranscriptPosition, drop: "head" | "tail"): Promise<{ from: TranscriptPosition; to: TranscriptPosition; truncated: boolean; fragment: boolean }> {
    const floor = drop === "head" ? stepBack(sources, end, this.maxBytes) : stepBack(sources, target, this.pageBytes);
    const wanted = streamDistance(sources, floor, target) === Number.POSITIVE_INFINITY ? floor : target;
    const start = await this.safeStart(sources, wanted, floor);
    const to = drop === "head" || streamDistance(sources, start.from, end) <= this.maxBytes ? end : stepForward(sources, start.from, this.maxBytes);
    return { from: start.from, to, truncated: start.truncated, fragment: !start.boundary };
  }
  /** A rewrite that grew the live file is noticed at the previously read tail, bounded to 64 bytes. */
  private async rewrittenBeforeTail(live: SourceState, previous: SourceState[]): Promise<boolean> {
    const sample = this.tailSample;
    if (!sample || sample.source !== live.key || sample.bytes.length === 0) return false;
    const seen = previous.find(source => source.key === live.key);
    if (!seen || live.size <= seen.size) return false;
    const bytes = await this.readBytesAt(live, Math.max(0, sample.offset - sample.bytes.length), sample.offset);
    return !bytes.equals(sample.bytes);
  }
  private async captureSample(): Promise<void> {
    if (!this.to || this.cancelled()) { if (!this.to) this.tailSample = undefined; return; }
    const source = this.sourceOf(this.to);
    if (!source || !source.exists || this.to.offset <= 0) { this.tailSample = undefined; return; }
    const from = Math.max(0, this.to.offset - WINDOW_SAMPLE_BYTES);
    const bytes = await this.readBytesAt(source, from, this.to.offset);
    this.tailSample = bytes.length ? { source: source.key, offset: this.to.offset, bytes } : undefined;
  }

  private snapshot(): TranscriptSnapshot {
    const window = this.from && this.to
      ? { from: { ...this.from }, to: { ...this.to }, atStart: this.atStart, atEnd: this.atEnd, entries: this.entries.length } : undefined;
    const entries = this.entries.map(entry => entry.span
      ? { ...entry, span: { start: { ...entry.span.start }, end: { ...entry.span.end } } } : { ...entry });
    return { entries, loading: this.loading, sourceEpoch: this.sourceEpoch, revision: this.revision, outputRevision: this.outputRevision,
      usageComplete: this.usage !== undefined && this.parsedWhole,
      ...(this.usage !== undefined && this.parsedWhole ? { usage: { ...this.usage } } : {}),
      ...(this.provider ? { provider: this.provider } : {}), ...(this.model ? { model: this.model } : {}),
      ...(window ? { window } : {}), ...(this.notice ? { notice: this.notice } : {}) };
  }
}

/** Text retained by a window, for the memory budget shared with the raw window bytes. */
function textBytes(entries: TranscriptEntry[]): number {
  let total = 0;
  // UTF-8 bytes: multi-byte content must not be counted by string length.
  for (const entry of entries) total += (entry.text ? Buffer.byteLength(entry.text, "utf8") : 0) + (entry.input ? Buffer.byteLength(entry.input, "utf8") : 0);
  return total;
}
/** A group that continues past the window end is marked, never merged or invented. */
function markTail(selected: TranscriptEntry[], parsed: TranscriptEntry[], openAtEnd: boolean): TranscriptEntry[] {
  if (!selected.length) return selected;
  // Ids, not object equality: a fragment-marked copy of the same entry is still the same entry.
  const droppedNewest = parsed.length > selected.length && parsed[parsed.length - 1].id !== selected[selected.length - 1].id;
  if (!droppedNewest && !openAtEnd) return selected;
  const last = selected[selected.length - 1];
  return [...selected.slice(0, -1), { ...last, partial: last.partial ?? "tail" }];
}
