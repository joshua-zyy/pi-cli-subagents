import { isKeyRelease, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentView } from "../types.js";
import { formatElapsed, isActive, oneLine, phaseColor, phaseIcon, rightAlign, viewElapsed, viewStartedAt, type UiTheme } from "./format.js";

const KEY = "cli-subagents-fleet";
const LINGER_MS = 4000;
const MAX_ROWS = 5;

/**
 * Pi's prompt editor is the only component that owns typing; dialogs and selectors are not editors.
 * Duck-typing avoids `instanceof`, because a globally installed Pi bundles its own copy of pi-tui.
 */
function isPromptEditor(component: unknown): boolean {
  const candidate = component as { getText?: unknown; getExpandedText?: unknown; setText?: unknown } | null;
  return Boolean(candidate) && typeof candidate!.getText === "function" && typeof candidate!.getExpandedText === "function" && typeof candidate!.setText === "function";
}

/** Below-editor navigation for live agents. The existing status widget remains the activity summary. */
export class FleetView {
  private agents: AgentView[] = [];
  private selectedId: string | undefined;
  private active = false;
  private viewing = false;
  private registered = false;
  private tui?: TUI;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ui: Pick<ExtensionUIContext, "setWidget" | "onTerminalInput" | "getEditorText">,
    private readonly read: () => AgentView[],
    private readonly open: (id: string) => void,
  ) {
    this.unsubscribe = ui.onTerminalInput((data) => this.handleKey(data));
  }

  update(): void {
    if (this.disposed) return;
    try { this.agents = this.read().filter((agent) => isActive(agent.phase) || Date.now() - agent.updatedAt < LINGER_MS)
      .sort((a, b) => viewStartedAt(a) - viewStartedAt(b)); }
    catch { return; } // Keep the last valid snapshot while a worker updates its state file.
    if (this.selectedId && !this.agents.some((agent) => agent.id === this.selectedId)) this.selectedId = undefined;
    if (!this.agents.length) {
      this.active = false;
      if (this.registered) { this.ui.setWidget(KEY, undefined); this.registered = false; this.tui = undefined; }
      return;
    }
    if (!this.registered) {
      this.ui.setWidget(KEY, (tui, theme) => {
        this.tui = tui;
        return { render: (width) => this.render(width, theme), invalidate() {} };
      }, { placement: "belowEditor" });
      this.registered = true;
    }
    this.tui?.requestRender();
  }

  private handleKey(data: string): { consume: true } | undefined {
    const tui = this.tui;
    if (this.disposed || this.viewing || !this.agents.length || isKeyRelease(data)) return undefined;
    // Input listeners run before modal dialogs; only the actual prompt editor may activate FleetView.
    const focused = tui ? (tui as TUI & { getFocusedComponent?(): unknown }).getFocusedComponent?.() : undefined;
    if (!tui || !isPromptEditor(focused)) {
      if (this.active) { this.active = false; this.selectedId = undefined; tui?.requestRender(); }
      return undefined;
    }
    if (!this.active) {
      if ((matchesKey(data, "down") || matchesKey(data, "left")) && this.ui.getEditorText() === "") {
        this.active = true; this.selectedId = undefined; tui.requestRender(); return { consume: true };
      }
      return undefined;
    }
    const index = this.selectedId ? this.agents.findIndex((agent) => agent.id === this.selectedId) + 1 : 0;
    if (matchesKey(data, "down")) this.selectedId = this.agents[Math.min(this.agents.length - 1, index)]?.id;
    else if (matchesKey(data, "up")) {
      if (index === 0) { this.active = false; tui.requestRender(); return { consume: true }; }
      this.selectedId = this.agents[index - 2]?.id;
    } else if (matchesKey(data, "escape")) { this.active = false; this.selectedId = undefined; }
    else if (matchesKey(data, "return")) {
      if (this.selectedId) { this.viewing = true; this.open(this.selectedId); }
      else this.active = false;
    } else { this.active = false; this.selectedId = undefined; return undefined; }
    tui.requestRender();
    return { consume: true };
  }

  viewerClosed(): void { this.viewing = false; this.tui?.requestRender(); }

  private render(width: number, theme: UiTheme): string[] {
    if (width <= 0) return [];
    const now = Date.now();
    const selected = this.selectedId ? this.agents.findIndex((agent) => agent.id === this.selectedId) + 1 : 0;
    const windowStart = Math.max(0, selected - MAX_ROWS);
    const visible = this.agents.slice(windowStart, windowStart + MAX_ROWS);
    const lines = [theme.fg("dim", this.active ? "  ↑↓ select · Enter view · Esc back" : "  ↓ / ← at empty prompt: select an agent")];
    lines.push(`  ${selected === 0 && this.active ? theme.fg("accent", "●") : theme.fg("dim", "○")} main`);
    if (windowStart > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${windowStart} more`), width));
    for (const agent of visible) {
      const focused = this.active && agent.id === this.selectedId;
      const icon = isActive(agent.phase) ? "●" : phaseIcon(agent.phase);
      const left = `  ${focused ? theme.fg("accent", "●") : theme.fg("dim", "○")} ${theme.fg(phaseColor(agent.phase), icon)} ${theme.fg("text", agent.role)}  ${theme.fg(focused ? "text" : "muted", oneLine(agent.task, 80) || "(No task summary)")}`;
      const right = `${formatElapsed(viewElapsed(agent, now))} · ${agent.phase}`;
      lines.push(rightAlign(left, theme.fg("dim", right), width));
    }
    const below = this.agents.length - windowStart - visible.length;
    if (below > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${below} more`), width));
    return lines.map((line) => truncateToWidth(line, width));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    if (this.registered) this.ui.setWidget(KEY, undefined);
    this.registered = false; this.tui = undefined;
  }
}
