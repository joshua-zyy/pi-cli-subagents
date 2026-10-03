import type { TranscriptEntry, TranscriptSnapshot, TranscriptWindowInfo } from "./transcript.js";

/** A display list, not a disk cursor. Reading a page must not evict the text under the reader. */
export class ConversationHistory<T extends TranscriptSnapshot = TranscriptSnapshot> {
  private current?: T;
  private raw?: T;
  private revision = 0;
  constructor(private readonly maxEntries = 1200, private readonly maxBytes = 8 * 1024 * 1024) {}

  get readerWindow(): TranscriptWindowInfo | undefined { return this.raw?.window; }
  /** Re-publish already-read live values when leaving a paused view; no disk read is needed. */
  get readerSnapshot(): T | undefined { return this.raw; }

  accept(next: T, kind: "refresh" | "older" | "newer" | "latest", pinned: ReadonlySet<string>): T {
    const previous = this.current;
    const protectedIds = new Set(pinned);
    if (previous && next.sourceEpoch !== undefined && this.raw?.sourceEpoch !== undefined && next.sourceEpoch < this.raw.sourceEpoch) return previous;
    const reset = !previous?.window || kind === "latest" || next.sourceEpoch !== previous.sourceEpoch;
    if (reset) protectedIds.clear();
    // A poll started before a page may resolve afterwards. It is not a new display publication.
    if (!reset && next.revision !== undefined && this.raw?.revision !== undefined && next.revision < this.raw.revision) return previous;
    const samePublication = next.revision !== undefined && next.revision === this.raw?.revision;
    this.raw = next;
    if (!next.window) {
      this.current = { ...next, revision: ++this.revision, outputRevision: next.outputRevision ?? next.revision };
      return this.current;
    }
    let entries = reset ? [...next.entries] : [...previous.entries];
    let bounds = { ...next.window, from: { ...next.window.from }, to: { ...next.window.to } };
    if (!reset && previous.window) {
      bounds = { ...previous.window, from: { ...previous.window.from }, to: { ...previous.window.to } };
      let insertion = kind === "older" ? 0 : entries.length;
      // Only exact ids join entries. Source-span intersection is NOT message identity: fragments
      // stay separate, and simultaneous native tool calls can never be fused by this display layer.
      for (const incoming of next.entries) {
        // Replace an obsolete HEAD marker only when a full representation has the identical
        // payload and identical final source record. This is not a span-overlap/text merge.
        // Tools are excluded: equal tool outputs do not establish native call identity.
        if (!incoming.partial && (incoming.kind === "assistant" || incoming.kind === "user") && incoming.span) {
          const duplicates = entries.filter(entry => entry.partial === "head" && entry.kind === incoming.kind
            && entry.text === incoming.text && entry.title === incoming.title && entry.span
            && entry.span.start.source === incoming.span!.start.source
            && incoming.span!.start.offset <= entry.span.start.offset
            && entry.span.end.source === incoming.span!.end.source && entry.span.end.offset === incoming.span!.end.offset);
          if (duplicates.length === 1) {
            const duplicate = duplicates[0];
            if (protectedIds.delete(duplicate.id)) protectedIds.add(incoming.id);
            entries[entries.indexOf(duplicate)] = incoming;
          }
        }
        const index = entries.findIndex(entry => entry.id === incoming.id && entry.kind === incoming.kind);
        if (index < 0) {
          // A poll of the same disk page can thaw an existing entry, but cannot turn a rejected
          // historical prefetch into a live append at the wrong end of the list.
          if (samePublication && kind === "refresh") continue;
          entries.splice(insertion++, 0, incoming); continue;
        }
        const existing = entries[index];
        const older = kind === "older" || (incoming.span && existing.span && incoming.span.end.source === existing.span.end.source && incoming.span.end.offset < existing.span.end.offset);
        // Freeze visible entries while paused, including their layout. A later live publication can
        // update them after the reader leaves; historical replay must not regress a final tool result.
        if (!protectedIds.has(existing.id) && !older) entries[index] = incoming;
        insertion = index + 1;
      }
      if (!samePublication) {
        if (kind === "older") { bounds.from = { ...next.window.from }; bounds.atStart = next.window.atStart; }
        else { bounds.to = { ...next.window.to }; bounds.atEnd = next.window.atEnd; }
      }
    }
    let bytes = entries.reduce((sum, entry) => sum + entryBytes(entry), 0);
    // Evict only away from the visible entries. Pins are a subset of the previously bounded list,
    // and their objects are unchanged, so retaining them cannot make this budget unbounded.
    while (entries.length > 1 && (entries.length > this.maxEntries || bytes > this.maxBytes)) {
      let front = kind !== "older";
      if (protectedIds.has(entries[front ? 0 : entries.length - 1].id)) front = !front;
      const index = front ? 0 : entries.length - 1;
      if (previous?.window && protectedIds.has(entries[index].id)) {
        // Do not punch a hole between visible messages or exceed the budget. Keep the last display;
        // the next explicit page request still seeks from its unchanged edge.
        this.current = { ...previous, revision: ++this.revision,
          window: { ...previous.window, atEnd: kind === "older" && previous.window.atEnd } };
        return this.current;
      }
      bytes -= entryBytes(entries[index]);
      if (front) { entries.shift(); bounds.atStart = false; bounds.from = entries[0].span?.start ?? bounds.from; }
      else { entries.pop(); bounds.atEnd = false; bounds.to = entries.at(-1)!.span?.end ?? bounds.to; }
    }
    bounds.entries = entries.length;
    this.current = { ...next, entries, window: bounds, revision: ++this.revision, outputRevision: next.outputRevision ?? next.revision };
    return this.current;
  }
}

function entryBytes(entry: TranscriptEntry): number {
  return Buffer.byteLength(entry.text, "utf8") + Buffer.byteLength(entry.input ?? "", "utf8") + Buffer.byteLength(entry.title, "utf8") + Buffer.byteLength(entry.id, "utf8");
}
