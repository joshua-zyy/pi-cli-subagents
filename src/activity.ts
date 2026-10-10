import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { Cli } from "./types.js";
import { logSourceKey } from "./transcript.js";
import type { TranscriptEntry, TranscriptPosition } from "./transcript.js";
import { TranscriptWindow } from "./transcript-window.js";

/**
 * Byte-budget trimming is adapted from Lody's session-history-page.ts (Apache-2.0), fixed source:
 * https://github.com/LodyAI/Lody/blob/6dc434952ab2e942291cc8392316bf760afbdaf0/apps/cli/src/mcp/session-history-page.ts
 * Changes: native JSONL byte cursors instead of store indices; measured upstream omissions;
 * opaque entry ids; prefix-only, code-point-safe text/input/title clipping; 4–64 KiB total JSON cap.
 * Projection reference: Paseo activity-curator.ts at 29db2b79809fc032860ff4e8ee360fbe0073c3e9.
 */
export interface ActivityRequest {
  id: string;
  cli: Cli;
  threadId?: string;
  files: string[];
  cursor?: string;
  limit?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}
export interface ActivityEntry {
  id: string;
  kind: TranscriptEntry["kind"];
  title: string;
  text: string;
  input?: string;
  status?: TranscriptEntry["status"];
  partial?: TranscriptEntry["partial"];
  truncated?: true;
  /** Known UTF-8 textual bytes removed by Reader clipping and this page's clipping, not raw JSON bytes. */
  omittedBytes?: number;
}
export interface ActivityPage { id: string; entries: ActivityEntry[]; hasMore: boolean; cursor?: string; notice?: string }

interface Stamp { ino: string; dev: string; size: number; birth: string; mtime: string; ctime: string }
interface Source { key: string; file: string; stamp?: Stamp }
interface Cursor {
  v: 1;
  id: string;
  cli: Cli;
  threadId?: string;
  source: string;
  prefix: string;
  offset: number;
  /** Within-record anchor: no public ordinal, and no raw path-bearing transcript id. */
  entry?: { from: number; id: string };
  generation: Stamp & { sample: string };
}
const PREFIX = "activity:v1:";
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("base64url");
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const invalid = (reason: string): Error => new Error(`Invalid activity cursor: ${reason}.`);
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const hash = (s: unknown): s is string => typeof s === "string" && /^[\w-]{43}$/.test(s);
const decimal = (s: unknown): s is string => typeof s === "string" && /^-?\d{1,30}$/.test(s);
const encode = (cursor: Cursor): string => PREFIX + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
function decode(encoded: string, request: ActivityRequest): Cursor {
  try {
    if (typeof encoded !== "string" || encoded.length > 64 * 1024 || !encoded.startsWith(PREFIX)) throw invalid("malformed token");
    const body = encoded.slice(PREFIX.length), buffer = Buffer.from(body, "base64url");
    if (!/^[\w-]+$/.test(body) || buffer.toString("base64url") !== body) throw invalid("malformed encoding");
    const value = JSON.parse(buffer.toString("utf8")) as Cursor;
    if (!value || typeof value !== "object" || value.v !== 1 || value.id !== request.id || value.cli !== request.cli
      || value.threadId !== undefined && typeof value.threadId !== "string"
      || request.threadId !== undefined && value.threadId !== request.threadId
      || !hash(value.source) || !hash(value.prefix) || !integer(value.offset)) throw invalid("binding mismatch");
    const g = value.generation;
    if (!g || typeof g !== "object" || !integer(g.size) || value.offset > g.size || !hash(g.sample)
      || ![g.ino, g.dev, g.birth, g.mtime, g.ctime].every(decimal)) throw invalid("invalid generation witness");
    if (value.entry !== undefined && (!value.entry || !integer(value.entry.from) || value.entry.from >= value.offset || !hash(value.entry.id))) throw invalid("invalid entry anchor");
    return value;
  } catch { throw invalid("malformed token or instance/CLI/native-identity mismatch"); }
}
function stamp(info: BigIntStats): Stamp {
  if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Activity source must be a regular, seekable log file.");
  return { ino: String(info.ino), dev: String(info.dev), size: Number(info.size), birth: String(info.birthtimeNs), mtime: String(info.mtimeNs), ctime: String(info.ctimeNs) };
}
async function sourcesOf(files: string[], signal?: AbortSignal): Promise<Source[]> {
  const sources: Source[] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    let value: Stamp | undefined;
    try { value = stamp(await stat(file, { bigint: true })); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    signal?.throwIfAborted();
    sources.push({ file, key: logSourceKey(file), stamp: value });
  }
  return sources;
}
/** Metadata rejects observed shrink/replacement/same-size writes; growth alone is allowed. */
function assertContinues(previous: Stamp, current: Stamp | undefined): void {
  if (!current || current.ino !== previous.ino || current.dev !== previous.dev || current.birth !== previous.birth
    || current.size < previous.size || current.size === previous.size && (current.mtime !== previous.mtime || current.ctime !== previous.ctime)) {
    throw invalid("source missing, replaced, truncated or rewritten");
  }
}
/**
 * A bounded witness, NOT proof that an arbitrary prefix/history is unchanged. In particular a
 * far-away in-place rewrite plus growth (or a truncate/regrow that restores the witness) may pass.
 * No persisted epoch, hash index or inferred sourceEpoch is used.
 */
async function sample(source: Source, offset: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!source.stamp || offset > source.stamp.size) throw invalid("source byte position unavailable");
  let handle;
  try {
    handle = await open(source.file, "r");
    signal?.throwIfAborted();
    assertContinues(source.stamp, stamp(await handle.stat({ bigint: true })));
    signal?.throwIfAborted();
    const length = Math.min(64, offset), bytes = Buffer.alloc(length);
    if (length) {
      const { bytesRead } = await handle.read(bytes, 0, length, offset - length);
      signal?.throwIfAborted();
      if (bytesRead !== length) throw invalid("source shortened while reading witness");
    }
    assertContinues(source.stamp, stamp(await handle.stat({ bigint: true })));
    signal?.throwIfAborted();
    return digest(bytes);
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw invalid("source missing");
    throw error;
  } finally { await handle?.close(); }
}
const sourcePrefix = (sources: Source[], index: number): string => digest(sources.slice(0, index + 1).map(source => source.key).join("\0"));
async function validate(cursor: Cursor, sources: Source[], signal?: AbortSignal): Promise<Source> {
  const index = sources.findIndex(source => digest(source.key) === cursor.source), source = sources[index];
  if (!source || sourcePrefix(sources, index) !== cursor.prefix) throw invalid("source list no longer matches");
  assertContinues(cursor.generation, source.stamp);
  if (await sample(source, cursor.offset, signal) !== cursor.generation.sample) throw invalid("anchor bytes changed");
  return source;
}
function project(entry: TranscriptEntry, id: string): ActivityEntry {
  return { id, kind: entry.kind, title: entry.title, text: entry.text,
    ...(entry.input !== undefined ? { input: entry.input } : {}), ...(entry.status ? { status: entry.status } : {}),
    ...(entry.partial ? { partial: entry.partial } : {}), ...(entry.omittedBytes ? { truncated: true, omittedBytes: entry.omittedBytes } : {}) };
}
/** Prefix cuts are code-point safe, not grapheme-cluster safe. No display marker enters the byte ledger. */
function prefix(value: string, length: number): string {
  let end = Math.min(length, value.length);
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
  return value.slice(0, end);
}
function clip(entry: ActivityEntry, length: number): ActivityEntry {
  const next = { ...entry };
  let omitted = entry.omittedBytes ?? 0;
  for (const field of ["title", "text", "input"] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    const retained = prefix(value, length);
    next[field] = retained;
    omitted += Buffer.byteLength(value) - Buffer.byteLength(retained);
  }
  if (omitted) { next.truncated = true; next.omittedBytes = omitted; }
  return next;
}

/** Pure local-log query. A page reports available entries, never proves the log/history is complete. */
export async function readActivity(request: ActivityRequest): Promise<ActivityPage> {
  const { id, cli, signal } = request;
  signal?.throwIfAborted();
  const limit = request.limit ?? 20, maxBytes = request.maxBytes ?? 16 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be an integer from 1 to 100.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 64 * 1024) throw new RangeError("maxBytes must be an integer from 4096 to 65536.");
  const cursor = request.cursor === undefined ? undefined : decode(request.cursor, request);
  const files = [...new Map(request.files.map(file => [logSourceKey(file), file])).values()];
  const sources = await sourcesOf(files, signal);
  const cursorSource = cursor ? await validate(cursor, sources, signal) : undefined;
  const window = new TranscriptWindow(cli, cursor?.threadId ?? request.threadId, { maxEntries: limit + 1, omitClipMarkers: true, strictReads: true });
  try {
    const key = (entry: TranscriptEntry): string => digest(JSON.stringify([id, cli, window.nativeId ?? null, entry.id]));
    let snapshot;
    if (cursor && cursorSource) {
      const before = { source: cursorSource.key, offset: cursor.offset };
      const anchor = cursor.entry;
      if (anchor) {
        // Recover older siblings from the anchor's own record/group before crossing its byte start.
        // This extra bounded range is not a latest-tail attach or a replay from log zero.
        const from = { source: cursorSource.key, offset: anchor.from };
        snapshot = await window.readPage(files, { from, before, beforeEntry: entry => key(entry) === anchor.id, discoverIdentity: false, signal });
        if (!snapshot.entries.length) snapshot = await window.readPage(files, { before: from, discoverIdentity: false, signal });
      } else snapshot = await window.readPage(files, { before, discoverIdentity: false, signal });
    } else snapshot = await window.readPage(files, { signal });
    signal?.throwIfAborted();
    const current = await sourcesOf(files, signal);
    for (const [i, source] of sources.entries()) if (source.stamp) assertContinues(source.stamp, current[i]?.stamp);
    if (cursor) await validate(cursor, current, signal);
    // Missing-run placeholders have no trustworthy record position; their coverage notice is retained.
    let malformedProjection = false;
    const available = snapshot.entries.filter(entry => {
      const span = entry.span;
      if (!span || !current.some(source => source.key === span.start.source && source.stamp)) return false;
      if (typeof entry.title !== "string" || typeof entry.text !== "string" || entry.input !== undefined && typeof entry.input !== "string") {
        malformedProjection = true;
        return false;
      }
      return true;
    });
    let selected = available.slice(-limit);
    let entries = selected.map(entry => project(entry, key(entry)));
    let next: Cursor | undefined;
    const olderBytes = (position: TranscriptPosition): boolean => {
      const index = current.findIndex(source => source.key === position.source);
      return position.offset > 0 || current.slice(0, index).some(source => (source.stamp?.size ?? 0) > 0);
    };
    const make = (): ActivityPage => {
      const first = selected[0], position = first?.span?.start ?? snapshot.window?.from;
      const hasMore = position !== undefined && (olderBytes(position) || first !== undefined && available.indexOf(first) > 0);
      next = undefined;
      if (hasMore && position) {
        const index = current.findIndex(source => source.key === position.source), source = current[index];
        if (!source?.stamp) throw invalid("older position is unavailable");
        next = { v: 1, id, cli, ...(window.nativeId !== undefined ? { threadId: window.nativeId } : {}), source: digest(source.key), prefix: sourcePrefix(current, index),
          offset: first?.span?.end.offset ?? position.offset,
          ...(first ? { entry: { from: position.offset, id: key(first) } } : {}), generation: { ...source.stamp, sample: "0".repeat(43) } };
      }
      const notice = [snapshot.notice, malformedProjection ? "Some malformed transcript entries were skipped." : undefined, entries.some(entry => entry.partial) ? "Partial entries may lack unseen fragments; omittedBytes counts only measured textual clipping, not missing records or fragments." : undefined].filter(Boolean).join(" ");
      return { id, entries, hasMore, ...(next ? { cursor: encode(next) } : {}), ...(notice ? { notice } : {}) };
    };
    let page = make();
    while (entries.length > 1 && jsonBytes(page) > maxBytes) {
      selected = selected.slice(1); entries = entries.slice(1); page = make();
    }
    if (entries.length === 1 && jsonBytes(page) > maxBytes) {
      const original = entries[0];
      let low = 0, high = Math.max(original.title.length, original.text.length, original.input?.length ?? 0), best = clip(original, 0);
      while (low <= high) {
        const mid = Math.floor((low + high) / 2); entries = [clip(original, mid)];
        if (jsonBytes(make()) <= maxBytes) { best = entries[0]; low = mid + 1; } else high = mid - 1;
      }
      entries = [best]; page = make();
    }
    if (jsonBytes(page) > maxBytes) throw new Error("maxBytes cannot fit the activity identifiers, cursor and notice.");
    const pending = next;
    if (pending) {
      const source = current.find(value => digest(value.key) === pending.source);
      if (!source) throw invalid("cursor source unavailable");
      pending.generation.sample = await sample(source, pending.offset, signal);
      // A SHA-256 witness always replaces exactly 43 ASCII bytes, so this preserves the fitted JSON size.
      page.cursor = encode(pending);
    }
    signal?.throwIfAborted();
    return page;
  } finally { window.dispose(); }
}
