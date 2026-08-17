import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { previewLine, type StashEntry } from "./magazine.ts";

export interface MagazineOrderTheme {
  fg(color: "accent" | "dim" | "muted" | "text", text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

export interface MagazineOrderModeOptions {
  /** Fresh queue snapshot; callers may update it after each move or polling tick. */
  getEntries(): readonly StashEntry[];
  /** Stable ID selected in the magazine browser; order mode starts with it grabbed. */
  initialEntryId: string;
  /** Persist one adjacent move. The callback must refresh getEntries() before returning. */
  onMove(entryId: string, delta: -1 | 1): boolean;
  onClose(): void;
  theme: MagazineOrderTheme;
  maxVisibleRows?: number;
}

/**
 * Two-state magazine reorder UI.
 *
 * Grabbed: ↑/↓ persist adjacent moves and Enter releases the entry.
 * Cursor:  ↑/↓ navigate and Enter grabs the highlighted entry.
 * Escape closes; already-persisted moves are intentionally not rolled back.
 */
export class MagazineOrderMode implements Component {
  private readonly options: MagazineOrderModeOptions;
  private cursorEntryId: string;
  private cursorIndex = 0;
  private grabbed = true;

  constructor(options: MagazineOrderModeOptions) {
    this.options = options;
    this.cursorEntryId = options.initialEntryId;
    const initialIndex = options.getEntries().findIndex((entry) => entry.id === options.initialEntryId);
    this.cursorIndex = Math.max(0, initialIndex);
    if (initialIndex < 0) this.grabbed = false;
  }

  invalidate(): void {
    // Rendering is intentionally uncached because the queue can change in a
    // second Pi process while this component owns input.
  }

  isGrabbed(): boolean {
    return this.grabbed;
  }

  getCursorEntryId(): string | undefined {
    return this.reconcile(this.options.getEntries())?.id;
  }

  private reconcile(entries: readonly StashEntry[]): StashEntry | undefined {
    if (entries.length === 0) {
      this.cursorIndex = 0;
      this.cursorEntryId = "";
      this.grabbed = false;
      return undefined;
    }

    const stableIndex = entries.findIndex((entry) => entry.id === this.cursorEntryId);
    if (stableIndex >= 0) {
      this.cursorIndex = stableIndex;
      return entries[stableIndex];
    }

    // A concurrent process removed the highlighted entry. Keep the nearest
    // surviving row selected, but release grab state so an arrow cannot move the
    // replacement entry accidentally.
    this.cursorIndex = Math.min(this.cursorIndex, entries.length - 1);
    const replacement = entries[this.cursorIndex];
    this.cursorEntryId = replacement.id;
    this.grabbed = false;
    return replacement;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.options.onClose();
      return;
    }

    let entries = this.options.getEntries();
    const current = this.reconcile(entries);
    if (!current) return;

    if (matchesKey(data, Key.enter)) {
      this.grabbed = !this.grabbed;
      return;
    }

    const delta: -1 | 1 | undefined = matchesKey(data, Key.up)
      ? -1
      : matchesKey(data, Key.down)
        ? 1
        : undefined;
    if (delta === undefined) return;

    if (this.grabbed) {
      this.options.onMove(current.id, delta);
      entries = this.options.getEntries();
      this.reconcile(entries);
      return;
    }

    const nextIndex = Math.max(0, Math.min(this.cursorIndex + delta, entries.length - 1));
    this.cursorIndex = nextIndex;
    this.cursorEntryId = entries[nextIndex].id;
  }

  render(width: number): string[] {
    if (width <= 0) return [];

    const entries = this.options.getEntries();
    const current = this.reconcile(entries);
    const currentIndex = current ? entries.findIndex((entry) => entry.id === current.id) : -1;
    const title = current
      ? this.grabbed
        ? `Magazine order — moving #${currentIndex + 1}`
        : `Magazine order — selected #${currentIndex + 1}`
      : "Magazine order — empty";
    const hint = this.grabbed
      ? "↑↓ reorder · Enter release · Esc finish"
      : "↑↓ navigate · Enter select · Esc finish";

    const lines = [
      this.options.theme.fg("accent", this.options.theme.bold(truncateToWidth(title, width, "…"))),
      this.options.theme.fg("dim", truncateToWidth(hint, width, "…")),
    ];
    if (!current) {
      lines.push(this.options.theme.fg("muted", truncateToWidth("Magazine is empty", width, "…")));
      return lines;
    }

    const maxRows = Math.max(1, this.options.maxVisibleRows ?? 12);
    const start = Math.max(0, Math.min(currentIndex - Math.floor(maxRows / 2), entries.length - maxRows));
    const end = Math.min(entries.length, start + maxRows);
    if (start > 0) {
      lines.push(this.options.theme.fg("dim", truncateToWidth(`… ${start} above`, width, "…")));
    }

    for (let index = start; index < end; index++) {
      const entry = entries[index];
      const selected = entry.id === current.id;
      const marker = selected ? "▸" : "·";
      const raw = `${marker} #${index + 1} ${previewLine(entry.text, Math.max(1, width))}`;
      const fitted = truncateToWidth(raw, width, "…", selected);
      if (selected && this.grabbed) {
        lines.push(this.options.theme.bg("selectedBg", this.options.theme.fg("accent", this.options.theme.bold(fitted))));
      } else if (selected) {
        lines.push(this.options.theme.fg("accent", fitted));
      } else {
        lines.push(this.options.theme.fg("text", fitted));
      }
    }

    if (end < entries.length) {
      lines.push(this.options.theme.fg("dim", truncateToWidth(`… ${entries.length - end} below`, width, "…")));
    }
    return lines;
  }
}
