import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { CUSTOM_CHOICE, FIELD_LABELS, cliDetail, fieldChoices, fieldIsChoice, fieldValue, modeDetail, roleSummary, suppressesApprovals, visibleFields, type ChoiceOptions, type EditableField, type RoleRow, type Scope } from "../role-settings.js";
import { framePane, PANE_FRAME_MIN_WIDTH, PANE_FRAME_ROWS, oneLine, type UiColor, type UiTheme } from "./format.js";

export type RoleSettingsAction =
  | { kind: "close" }
  | { kind: "scope"; scope: Scope }
  | { kind: "set"; role: string; field: EditableField; value: string }
  | { kind: "edit"; role: string; field: EditableField }
  | { kind: "add" }
  | { kind: "remove"; role: string }
  | { kind: "save" };

export const SETTINGS_MAX_ROWS = 10;
const SCOPE_LABEL: Record<Scope, string> = { user: "personal", project: "project" };

/**
 * Where the panel should reopen. Every action rebuilds it from current state, so without this the
 * user would be thrown back to the role list — and to the first row — after each single change.
 */
export interface RoleSettingsCursor { role?: string; field?: EditableField }

/**
 * Snapshot-based role editor for `/cli-agents-setting`.
 * It returns one action; the command handler applies it (dialogs, file writes) and reopens the panel.
 */
export class RoleSettingsPanel {
  private view: "list" | "fields" | "choices" = "list";
  /** List cursor, field cursor and choice cursor are independent views of the same panel. */
  private rowIndex = 0;
  private fieldIndex = 0;
  private choiceIndex = 0;
  private settled = false;

  constructor(
    private readonly rows: RoleRow[],
    private readonly scope: Scope,
    private readonly trusted: boolean,
    private readonly dirty: boolean,
    private readonly theme: UiTheme,
    private readonly done: (action: RoleSettingsAction | undefined) => void,
    private readonly rowLimit: () => number = () => 0,
    private readonly frameColor?: (text: string) => string,
    /** Read live, so a background probe can widen the pickers while the panel is open. */
    private readonly choiceOptions: () => ChoiceOptions = () => ({}),
    cursor: RoleSettingsCursor = {},
  ) {
    const reopened = cursor.role ? this.rows.findIndex((row) => row.name === cursor.role) : -1;
    if (reopened >= 0) {
      this.rowIndex = reopened;
      this.view = "fields";
      // A field can disappear when the CLI changed, so fall back to the top of this role.
      const field = cursor.field ? visibleFields(this.rows[reopened].effective).indexOf(cursor.field) : -1;
      this.fieldIndex = field >= 0 ? field : 0;
    }
  }

  get mode(): "list" | "fields" | "choices" { return this.view; }
  get selection(): number { return this.rowIndex; }

  invalidate(): void { /* No cache */ }

  private get selected(): RoleRow | undefined {
    if (!this.rows.length) return undefined;
    return this.rows[Math.min(this.rowIndex, this.rows.length - 1)];
  }
  private get fields(): EditableField[] {
    const role = this.selected?.effective;
    return role ? visibleFields(role) : [];
  }
  private get field(): EditableField | undefined {
    return this.fields[Math.min(this.fieldIndex, this.fields.length - 1)];
  }
  private get values(): string[] {
    const role = this.selected?.effective, field = this.field;
    if (!role || !field) return [];
    return fieldChoices(role, field, this.choiceOptions());
  }
  private get choices(): string[] {
    const field = this.field;
    // A discovered list still needs an escape hatch, and while discovery runs it is the only way out.
    return field === "model" || field === "provider" ? [...this.values, CUSTOM_CHOICE] : this.values;
  }

  handleInput(data: string): void {
    if (this.settled) return;
    if (this.view === "choices") this.handleChoices(data);
    else if (this.view === "fields") this.handleFields(data);
    else this.handleList(data);
  }

  private handleChoices(data: string): void {
    const selected = this.selected, field = this.field, choices = this.choices;
    if (!selected || !field) return;
    if (matchesKey(data, "up")) this.choiceIndex = Math.max(0, this.choiceIndex - 1);
    else if (matchesKey(data, "down")) this.choiceIndex = Math.min(choices.length - 1, this.choiceIndex + 1);
    else if (matchesKey(data, "return")) {
      const value = choices[this.choiceIndex];
      if (value === undefined && !this.choiceOptions().pending) this.finish({ kind: "edit", role: selected.name, field });
      // The escape hatch reopens the host text dialog instead of setting a literal sentinel.
      else if (value === CUSTOM_CHOICE) this.finish({ kind: "edit", role: selected.name, field });
      else if (value !== undefined) this.finish({ kind: "set", role: selected.name, field, value });
    } else if (matchesKey(data, "escape") || matchesKey(data, "left")) this.view = "fields";
  }

  private handleFields(data: string): void {
    const selected = this.selected, fields = this.fields, field = this.field;
    if (!selected) return;
    if (matchesKey(data, "up")) this.fieldIndex = Math.max(0, this.fieldIndex - 1);
    else if (matchesKey(data, "down")) this.fieldIndex = Math.min(fields.length - 1, this.fieldIndex + 1);
    else if (matchesKey(data, "return") && field) {
      if (fieldIsChoice(selected.effective, field, this.choiceOptions())) {
        this.view = "choices";
        this.choiceIndex = Math.max(0, this.choices.indexOf(fieldValue(selected.effective, field)));
      } else this.finish({ kind: "edit", role: selected.name, field });
    } else if (matchesKey(data, "s") && this.dirty) this.finish({ kind: "save" });
    else if (matchesKey(data, "d")) this.finish({ kind: "remove", role: selected.name });
    else if (matchesKey(data, "escape") || matchesKey(data, "left")) { this.view = "list"; this.fieldIndex = 0; }
  }

  private handleList(data: string): void {
    const selected = this.selected;
    if (matchesKey(data, "up")) this.rowIndex = Math.max(0, this.rowIndex - 1);
    else if (matchesKey(data, "down")) this.rowIndex = Math.min(this.rows.length - 1, this.rowIndex + 1);
    // Enter opens the highlighted role; the field cursor starts at the top of its own list.
    else if (matchesKey(data, "return") && selected) { this.view = "fields"; this.fieldIndex = 0; }
    else if (matchesKey(data, "tab") && this.trusted) this.finish({ kind: "scope", scope: this.scope === "user" ? "project" : "user" });
    else if (matchesKey(data, "a")) this.finish({ kind: "add" });
    else if (matchesKey(data, "s") && this.dirty) this.finish({ kind: "save" });
    else if (matchesKey(data, "d") && selected) this.finish({ kind: "remove", role: selected.name });
    else if (matchesKey(data, "escape") || matchesKey(data, "q")) this.finish({ kind: "close" });
  }

  render(width: number): string[] {
    const lines = this.view === "list" ? this.renderList() : this.view === "fields" ? this.renderFields() : this.renderChoices();
    const available = this.availableRows;
    const framed = width >= PANE_FRAME_MIN_WIDTH;
    // The frame costs two rows, so those are reserved before the content is bounded.
    const room = framed && available > 0 ? available - PANE_FRAME_ROWS : available;
    const bounded = room > 0 && lines.length > room ? [...lines.slice(0, Math.max(0, room - 2)), this.theme.fg("dim", "…"), lines[lines.length - 1]] : lines;
    if (!framed) return width > 0 ? bounded.map((line) => truncateToWidth(line, width)) : bounded;
    return framePane(bounded, width, this.frameColor ?? ((text: string) => this.theme.fg("dim", text)));
  }

  private get availableRows(): number {
    const rows = this.rowLimit();
    if (!Number.isFinite(rows) || rows <= 0) return 0;
    return Math.floor(rows);
  }

  private visibleRows(total: number): number {
    const available = this.availableRows;
    if (available <= 0) return Math.max(1, total);
    return Math.max(1, Math.min(total, available - 4));
  }

  private finish(action: RoleSettingsAction): void {
    if (this.settled) return;
    this.settled = true;
    this.done(action);
  }

  private hint(items: [string, string][]): string {
    return items.map(([key, label]) => `${this.theme.fg("dim", key)}${this.theme.fg("muted", ` ${label}`)}`)
      .join(this.theme.fg("dim", " · "));
  }

  private row(selected: boolean, label: string, detail: string): string {
    const marker = selected ? this.theme.fg("accent", "› ") : "  ";
    const color: UiColor = selected ? "accent" : "text";
    const suffix = detail ? this.theme.fg("muted", `  ${detail}`) : "";
    return `${marker}${this.theme.fg(color, label)}${suffix}`;
  }

  private window<T>(items: T[], selected: number, render: (item: T, isSelected: boolean) => string): string[] {
    const visible = this.visibleRows(items.length);
    const start = selected < visible ? 0 : selected - visible + 1;
    const lines: string[] = [];
    if (start > 0) lines.push(this.theme.fg("dim", `↑ ${start} more`));
    for (let index = start; index < Math.min(items.length, start + visible); index++) lines.push(render(items[index], index === selected));
    if (items.length > start + visible) lines.push(this.theme.fg("dim", `↓ ${items.length - start - visible} more`));
    return lines;
  }

  private originLabel(row: RoleRow): string {
    return row.origin === "built-in" ? "built-in" : SCOPE_LABEL[row.origin];
  }

  private choiceDetail(field: EditableField, choice: string, current: string): string {
    const parts: string[] = [];
    if (choice === current) parts.push("current");
    if (field === "cli") parts.push(cliDetail(choice));
    if (field === "mode") parts.push(modeDetail(choice));
    return parts.join(" · ");
  }

  private scopeHeading(): string {
    if (this.scope === "project" && !this.trusted) return `${SCOPE_LABEL[this.scope]} (untrusted, not loaded)`;
    return SCOPE_LABEL[this.scope];
  }

  private scopeHint(): string {
    if (!this.trusted) return "project (untrusted)";
    return this.scope === "user" ? "project" : "personal";
  }

  private renderList(): string[] {
    const lines = [this.theme.bold(this.theme.fg("accent", `Subagent roles — ${this.scopeHeading()}${this.dirty ? " • unsaved" : ""}`))];
    if (!this.rows.length) {
      lines.push(this.theme.fg("dim", "No roles available"));
      lines.push(this.hint([["a", "add"], ["esc", "close"]]));
      return lines;
    }
    const actions: [string, string][] = [["↑↓", "select"], ["enter", "edit"], ["tab", this.scopeHint()], ["a", "add"], ["d", "remove"]];
    if (this.dirty) actions.push(["s", "save"]);
    actions.push(["esc", this.dirty ? "discard" : "close"]);
    lines.push(this.hint(actions));
    lines.push(...this.window(this.rows, this.rowIndex, (row, selected) => this.row(selected, row.name, `${roleSummary(row.effective)} · ${this.originLabel(row)}`)));
    return lines;
  }

  private renderFields(): string[] {
    const selected = this.selected;
    if (!selected) return [this.theme.fg("dim", "No role selected")];
    const lines = [this.theme.bold(this.theme.fg("accent", `${selected.name} — ${this.scopeHeading()}${this.dirty ? " • unsaved" : ""}`))];
    const actions: [string, string][] = [["↑↓", "select"], ["enter", "change"], ["d", "remove override"]];
    if (this.dirty) actions.push(["s", "save"]);
    actions.push(["esc", this.dirty ? "discard" : "back"]);
    lines.push(this.hint(actions));
    // Only prompt for a CLI when nothing CLI-specific is on screen yet.
    const cliSpecific = this.fields.some((field) => field !== "cli" && field !== "description" && field !== "instructions");
    if (!selected.effective.cli && !cliSpecific) lines.push(this.theme.fg("muted", "Choose a CLI first; its specific options appear after that."));
    if (this.choiceOptions().pending && (selected.effective.cli === "pi" || selected.effective.cli === "codex"))
      lines.push(this.theme.fg("muted", "Reading each CLI's own model list; that field becomes a picker when it arrives."));
    if (!selected.override) lines.push(this.theme.fg("muted", `No ${SCOPE_LABEL[this.scope]} entry yet; changing a field creates one.`));
    if (selected.effective.mode && suppressesApprovals(selected.effective.mode))
      lines.push(this.theme.fg("warning", `mode ${selected.effective.mode}: this role stops asking for approval`));
    lines.push(...this.window(this.fields, this.fieldIndex, (field, isSelected) => this.row(isSelected, FIELD_LABELS[field], this.fieldDisplay(selected, field))));
    return lines;
  }

  private fieldDisplay(row: RoleRow, field: EditableField): string {
    const value = fieldValue(row.override ?? row.effective, field);
    if (!row.override && value) return `${oneLine(value, 80)}  (inherited)`;
    return oneLine(value, 80) || "(empty)";
  }

  private renderChoices(): string[] {
    const selected = this.selected, field = this.field;
    if (!selected || !field) return [this.theme.fg("dim", "No field selected")];
    const lines = [this.theme.bold(this.theme.fg("accent", `${selected.name} · ${FIELD_LABELS[field]}`))];
    lines.push(this.hint([["↑↓", "select"], ["enter", "apply"], ["esc", "back"]]));
    const choices = this.choices, current = fieldValue(selected.override ?? selected.effective, field);
    // While discovery runs the list only holds the escape hatch, so say why it is still empty.
    if (!this.values.length && this.choiceOptions().pending) lines.push(this.theme.fg("muted", "Reading this CLI's own model list…"));
    lines.push(...this.window(choices, this.choiceIndex, (choice, isSelected) => this.row(isSelected, choice, this.choiceDetail(field, choice, current))));
    if (current && !choices.includes(current)) lines.push(this.theme.fg("dim", `Current value: ${current}`));
    return lines;
  }
}
