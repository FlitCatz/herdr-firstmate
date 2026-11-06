// Firstmate board: projects on top, tasks below. Fleet data comes from
// fm-fleet-snapshot.sh; this mod never changes it. Adding or removing a project
// only sends a note through fm-inbox.sh, and firstmate does the work under its
// project-management procedure. The Command buttons type their slash command
// into the open firstmate terminal through hc.
// props: { home, snapshot_file?, collapsed?, ui? }. home is the firstmate
// installation and operational home; the other props support preview fixtures.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, h_resizable, resizable_panel } from "gpui-base";
import { exec, pickFolder, props, readTextFile, watchFolder, theme, settings, run, focused } from "herdr";
import { FolderViewer } from "./viewer.js";

// Board text follows the terminal font size and grows as the Board widens. The sizes below
// were drawn for Herdr's default 14px terminal font. At the stacking width they keep that
// proportion to the terminal font; by GROW_FULL_PX the largest Board text (12px titles)
// reaches the terminal font size, which is the ceiling.
const DESIGN_FONT_PX = 14;
const LARGEST_TEXT_PX = 12;
const GROW_FULL_PX = 1600;
let fontScale = 1;
const fs = (px) => Math.round(px * fontScale * 2) / 2;
function readFontScale(width) {
  let terminal = DESIGN_FONT_PX;
  try { terminal = Number(settings()?.font_size) || DESIGN_FONT_PX; } catch {}
  const narrow = terminal / DESIGN_FONT_PX, wide = terminal / LARGEST_TEXT_PX;
  const w = Number.isFinite(width) ? width : 0;
  const k = Math.min(1, Math.max(0, (w - STACK_BELOW_PX) / (GROW_FULL_PX - STACK_BELOW_PX)));
  fontScale = narrow + (wide - narrow) * k;
}

const REFRESH_FALLBACK_MS = 30000;
const MIN_GAP_MS = 2000;
const DONE_LIMIT = 20;
const STACK_BELOW_PX = 720; // narrower than this, columns stack as an accordion
const COLLAPSED_KEY = "collapsed";
const FOLDED_KEY = "folded";
const PROJECTS = "projects";
const COMMANDS = "commands";

// Firstmate's own names. Optional columns appear only while they hold a card.
const COLUMNS = [
  // Later work: queued items the captain set aside as "future".
  { id: "todo", title: "Todo", color: "idle" },
  { id: "queued", title: "Queued", color: "idle" },
  { id: "held", title: "Held", color: "blocked", optional: true },
  { id: "working", title: "Working", color: "working" },
  { id: "parked", title: "Parked", color: "blocked", optional: true },
  { id: "blocked", title: "Blocked", color: "blocked", optional: true },
  { id: "paused", title: "Paused", color: "idle", optional: true },
  { id: "review", title: "Review", color: "done", optional: true },
  { id: "unknown", title: "Unknown", color: "unknown", optional: true },
  { id: "done", title: "Done", color: "done" },
  { id: "failed", title: "Failed", color: "ansi1" },
];
const MODES = [
  { id: "no-mistakes-prod-only", label: "Validate product changes" },
  { id: "no-mistakes", label: "Always validate" },
  { id: "direct-PR", label: "Direct PR" },
  { id: "local-only", label: "Local only" },
];
const modeLabel = (id) => MODES.find((m) => m.id === id)?.label ?? id;
const home = () => typeof props()?.home === "string" ? props().home.trim().replace(/(.)\/+$/, "$1") : "";
// Fixed to Korea time, which has no daylight saving.
function koreaTime(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 19);
}
const base = (path) => (path ?? "").split("/").filter(Boolean).pop() ?? "";
// The backlog writes "-" for an item with no project; such items are firstmate's own work.
const projectOf = (...paths) => paths.map(base).find((p) => p && p !== "-") ?? "";
// A project keeps one color on every card, so the eye can group cards without reading.
// Mid-tone hues that all carry white text. Projects get them in name order, so no two
// share a color until there are more projects than hues; a color picked on the project row wins.
const PROJECT_COLORS = [
  "#2f7fc1", "#2e9d5b", "#c0563a", "#8a4fbf", "#b8860b", "#16958f", "#c23d7a",
  "#4f5fc7", "#6b8e23", "#a0522d", "#0f7ea8", "#9c3fa3", "#58708a", "#b03a3a",
];
const PROJECT_COLORS_KEY = "projectColors";
function autoColors(names) {
  return new Map([...new Set(names)].sort().map((n, i) => [n, PROJECT_COLORS[i % PROJECT_COLORS.length]]));
}
// Three-letter tags: one word takes its first three letters, two words take
// two letters and an initial (mail-server -> MAS), more words take initials (TPO). A clash
// with an earlier name tries other letters of the name, then a digit.
function abbreviations(names) {
  const out = new Map(), used = new Set();
  for (const name of [...new Set(names)].sort()) {
    const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const letters = words.join("");
    const first = words.length >= 3 ? words.slice(0, 3).map((w) => w[0]).join("")
      : words.length === 2 ? words[0].slice(0, 2) + words[1][0]
      : letters.slice(0, 3);
    const tries = [first];
    for (let i = 1; i < letters.length; i++) for (let j = i + 1; j < letters.length; j++) tries.push(letters[0] + letters[i] + letters[j]);
    let tag = tries.map((s) => s.toUpperCase()).find((s) => s.length === 3 && !used.has(s));
    for (let n = 2; !tag; n++) if (!used.has(first.slice(0, 2).toUpperCase() + n)) tag = first.slice(0, 2).toUpperCase() + n;
    used.add(tag); out.set(name, tag);
  }
  return out;
}

// Badge text is white, so a light theme color (bright yellow or cyan) is darkened until white stays legible.
function readableOnWhite(hex) {
  const m = /^#([0-9a-f]{6})/i.exec(hex ?? "");
  if (!m) return hex;
  const rgb = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  const k = Math.min(1, 0.5 / Math.max(lum, 0.01));
  return "#" + rgb.map((c) => Math.round(c * k).toString(16).padStart(2, "0")).join("");
}

function parseRegistry(text) {
  const out = [];
  for (const line of (text ?? "").split("\n")) {
    const m = /^- (.+?)(?: \[([^\]]*)\])? - (.*?)(?: \(added [^)]*\))?$/.exec(line.trim());
    if (!m) continue;
    const tokens = (m[2] ?? "").split(/\s+/).filter(Boolean);
    const mode = tokens.find((x) => !x.startsWith("+") && !x.includes("=")) ?? "no-mistakes";
    out.push({ name: m[1], mode, yolo: tokens.includes("+yolo"), desc: m[3] });
  }
  return out;
}

// True when the harness state is unknown but the board placed the card from other evidence.
function inferred(task, record) {
  return task?.current_state?.state === "unknown" && columnOf(record, task) !== "unknown";
}

// The worker's last status line without its state prefix and timestamp.
function lastEventDetail(task) {
  return (task?.hints?.last_event_text ?? "").replace(/^[a-z-]+\s*(\[[^\]]*\]\s*)*:\s*/, "");
}

function columnOf(record, task) {
  const state = task?.current_state?.state;
  if (state === "failed") return "failed";
  if (state === "done" || record?.state === "done") return "done";
  if (task?.hints?.pending_decision) return "parked";
  if (task?.hints?.blocked_event) return "blocked";
  // Firstmate cannot observe Codex, but hc can: trust only an explicit working report.
  if (state === "unknown" && task?.core_status === "working") return "working";
  // Codex on hc never reports its own state; fall back to the worker's last status event.
  if (state === "unknown") {
    const last = /^([a-z-]+)/.exec(task?.hints?.last_event_text ?? "")?.[1];
    if (last === "done") return task?.pr?.url ? "review" : "paused";
    if (last === "needs-decision") return "parked";
    if (last === "blocked" || last === "paused" || last === "working") return last;
    if (last === "resolved") return "working";
  }
  if (["blocked", "paused", "parked", "unknown", "working"].includes(state)) return state;
  if (record?.state === "queued") {
    if (record.hold_kind === "future") return "todo";
    return record.hold_reason ? "held" : "queued";
  }
  return "unknown"; // in flight with no worker evidence: never show it as healthy
}

// Firstmate records no structured options, so grouping reads only this explicit
// format, never prose: "[topic=<slug>] question | A: option | B: option | Recommended: A".
function parseDecision(text) {
  if (!text) return null;
  const tagged = /^\s*\[topic=([^\]\s]+)\]\s*/.exec(text);
  const parts = text.slice(tagged?.[0].length ?? 0).split(/\s*\|\s*/);
  const options = [];
  let recommended = "";
  for (const part of parts.slice(1)) {
    const option = /^([A-Z])[:：]\s*(.+)$/.exec(part);
    const rec = /^(?:권장|Recommended)[:：]\s*(.+)$/.exec(part);
    if (option) options.push({ label: option[1], text: option[2] });
    else if (rec) recommended = rec[1];
  }
  if (!tagged && !options.length) return null;
  return { topic: tagged?.[1] ?? null, question: parts[0], options, recommended };
}

// Done means the worker finished, not that its PR landed. Teardown moves landed
// work to the backlog's Done section, so a live done task with an unmerged PR is waiting.
function prWaiting(record, task) {
  if (task?.current_state?.state !== "done" || !task?.pr?.url) return false;
  if (record?.state === "done" || record?.merged) return false;
  return !/\b(merged|closed)\b/i.test(task.current_state.detail ?? "");
}

// "Waiting on <title>", or "Waiting on 2 · <first title>"; the card's own project name is
// dropped from the front of the title because the card already shows it.
function waitingLabel(c) {
  const strip = (title) => (c.project && title.startsWith(`${c.project} `) ? title.slice(c.project.length + 1) : title);
  const n = c.waitingOn.length;
  return `Waiting on ${n > 1 ? `${n} · ` : ""}${strip(c.waitingOn[0])}`;
}

// What the Kanban search matches, lowercased: the task id and the card's text (title,
// full note or detail even where the card truncates or hides it, and its decision's question and options).
function searchText(c) {
  const decision = c.decision ? [c.decision.question, ...c.decision.options.map((o) => o.text)] : [];
  return [c.id, c.title, c.detail, ...decision].filter(Boolean).join("\n").toLowerCase();
}

function cardsFrom(snapshot) {
  const tasks = new Map((snapshot.tasks ?? []).map((t) => [t.id, t]));
  const records = (snapshot.backlog?.records ?? []).filter((r) => r.structured);
  const pairs = records.map((r) => ({ record: r, task: tasks.get(r.id) }));
  const known = new Set(records.map((r) => r.id));
  const titles = new Map(records.map((r) => [r.id, r.title ?? r.id]));
  for (const t of snapshot.tasks ?? []) if (!known.has(t.id)) pairs.push({ record: null, task: t });
  return pairs.map(({ record, task }) => {
    const decisionText = record?.hold_reason || task?.hints?.open_decisions?.[0]?.summary || "";
    const decision = parseDecision(decisionText);
    return {
    id: record?.id ?? task.id,
    decision,
    column: columnOf(record, task),
    title: record?.title ?? task.id,
    // Unfinished work this item waits on, by title; empty when it can start.
    waitingOn: (record?.unresolved_blocker_ids ?? []).map((id) => titles.get(id) ?? id),
    waitingIds: record?.unresolved_blocker_ids ?? [],
    // Backlog priority 0 (highest) to 4; null when the item has none.
    priority: /^[0-4]$/.test(String(record?.priority ?? "")) ? Number(record.priority) : null,
    project: projectOf(task?.project, record?.repo),
    // An unobservable worker shows the state its column was derived from, not "unknown".
    state: inferred(task, record) ? columnOf(record, task) : task?.current_state?.state ?? record?.state ?? "",
    detail: decision?.question || (inferred(task, record) ? lastEventDetail(task) : "") || task?.current_state?.detail || record?.hold_reason || "",
    pr: task?.pr?.url ?? record?.pr_url ?? null,
    prWaiting: prWaiting(record, task),
    // Only hc runs workers in Herdr terminals, so only those can be opened from here.
    terminal: task?.backend === "hc" ? /^[^:]+:(t\d+)$/.exec(task.endpoint?.target ?? "")?.[1] ?? null : null,
    // The worker's isolated copy, for the read-only Files/Changes view.
    worktree: task?.worktree?.present ? task.worktree.path : null,
    };
  });
}

export default class FmBoard extends View {
  init(_props, cx) {
    const ui = props()?.ui ?? {};
    this.cards = null; this.projects = []; this.requests = []; this.ready = null;
    this.error = null; this.notice = ""; this.generated = ""; this.loading = false; this.last = 0;
    this.size = null; this.collapsed = new Set(props()?.collapsed ?? this.loadSet(COLLAPSED_KEY));
    this.folded = new Set(ui.folded ?? this.loadSet(FOLDED_KEY));
    this.open = new Set(ui.open ?? []); this.filter = ui.filter ?? null;
    this.chainOpen = new Set(ui.chains ?? []);
    this.pasting = false;
    this.colorChoice = {};
    try { this.colorChoice = JSON.parse(localStorage.getItem(PROJECT_COLORS_KEY) ?? "{}") ?? {}; } catch {}
    this.adding = Boolean(ui.adding); this.confirm = ui.confirm ?? null; this.mode = MODES[0].id;
    this.source = InputState.new({ placeholder: "Repository URL (git@github.com:org/repo.git)" });
    this.name = InputState.new({ placeholder: "Name (optional)" });
    this.picked = null;
    this.ask = InputState.new({ placeholder: "What to investigate or do" }); this.askProject = null;
    // The Kanban search applies on Enter or the find icon, so the first press lands on match 1.
    this.search = InputState.new({ placeholder: "Search tasks", value: ui.search ?? "" });
    /** @type {string} */
    this.query = (ui.search ?? "").trim(); this.matchAt = 0;
    this.search.on("submit", (_e, cx) => this.findNext(cx));
    this.viewer = new FolderViewer(); this.viewProject = null;
    if (!home()) return;
    // props.ui.view (testing): open the viewer on that project's local copy.
    if (ui.view) this.openView(ui.view, { path: `${home()}/projects/${ui.view}`, title: `${ui.view} · local copy` }, cx);
    if (ui.viewTab) this.viewer.tab = ui.viewTab;
    if (ui.pick) this.usePath(ui.pick, cx);
    this.refresh(cx);
    if (props()?.snapshot_file) return;
    cx.timer.every(REFRESH_FALLBACK_MS, (cx) => this.refresh(cx));
    cx.timer.every(10000, (cx) => this.viewer.refresh(cx));
    for (const dir of ["state", "data"]) {
      cx.spawn(async (cx) => {
        for (;;) { await watchFolder(`${home()}/${dir}`); this.refresh(cx); }
      });
    }
  }

  loadSet(key) {
    try { return new Set(JSON.parse(localStorage.getItem(key) ?? "[]")); }
    catch { return new Set(); }
  }

  colorOf(name, t) {
    if (name === "firstmate" && !this.colorChoice[name]) return readableOnWhite(t.dim);
    return this.colorChoice[name] ?? this.autoColor?.get(name) ?? PROJECT_COLORS[0];
  }

  pickColor(name, color, cx) {
    if (color) this.colorChoice[name] = color; else delete this.colorChoice[name];
    try { localStorage.setItem(PROJECT_COLORS_KEY, JSON.stringify(this.colorChoice)); } catch {}
    cx.notify();
  }

  colorPicker(name, t) {
    const current = this.colorOf(name, t);
    const swatch = (id, color, label, onPick) => div().id(id).flex_none().w(18).h(18).rounded(9).bg(color)
      .border(2).border_color(color === current && (label !== "Auto" || !this.colorChoice[name]) ? t.foreground : t.surface)
      .cursor_pointer().hover((s) => s.opacity(0.75)).tooltip(label).on_click((_e, cx) => onPick(cx));
    return h_flex().gap(4).items_center().flex_wrap()
      .child(div().flex_none().text_size(fs(11)).text_color(t.dim).child("Color"))
      .children(PROJECT_COLORS.map((c) => swatch(`color-${name}-${c}`, c, c, (cx) => this.pickColor(name, c, cx))))
      .child(div().id(`color-${name}-auto`).flex_none().px(6).py(1).rounded(9).border(1)
        .border_color(this.colorChoice[name] ? t.border : t.foreground).text_size(fs(11)).text_color(t.muted)
        .cursor_pointer().hover((s) => s.opacity(0.75)).child("Auto")
        .on_click((_e, cx) => this.pickColor(name, null, cx)));
  }

  toggleFold(id, cx) {
    if (this.query) return;
    if (!this.folded.delete(id)) this.folded.add(id);
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...this.folded])); } catch {}
    cx.notify();
  }

  foldRow(id, t, folded, label, trailing) {
    const row = h_flex().id(`fold-${id}`).gap(6).items_center().cursor_pointer()
      .hover((s) => s.opacity(0.75)).on_click((_e, cx) => this.toggleFold(id, cx))
      .child(div().flex_none().text_size(fs(10)).text_color(t.dim).child(folded ? "▸" : "▾"))
      .child(div().flex_1().min_w(0).when(folded, (e) => e.truncate()).text_size(fs(12)).font_semibold().text_color(t.foreground).child(label));
    return trailing ? row.child(trailing) : row;
  }

  toggle(id, cx) {
    if (!this.collapsed.delete(id)) this.collapsed.add(id);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this.collapsed])); } catch {}
    cx.notify();
  }

  // Goes through env so a test home never reaches the real inbox.
  fm(script, args) {
    const root = home();
    return exec("/usr/bin/env", [`FM_HOME=${root}`, `${root}/bin/${script}`, ...args], { cwd: root });
  }

  refresh(cx) {
    if (this.loading || Date.now() - this.last < MIN_GAP_MS) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const snapshot = await this.loadSnapshot();
        if (snapshot.schema !== "fm-fleet-snapshot.v1") throw new Error(`unknown schema ${snapshot.schema}`);
        await this.readCoreStatus(snapshot);
        this.cards = cardsFrom(snapshot);
        this.generated = snapshot.generated ?? "";
        this.projects = parseRegistry(await readTextFile(`${home()}/data/projects.md`));
        await this.loadInbox();
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e); // keep the last good board on screen
      }
      this.loading = false; this.last = Date.now();
      cx.notify();
    });
  }

  async readCoreStatus(snapshot) {
    for (const task of snapshot.tasks ?? []) {
      if (task.backend !== "hc" || task.current_state?.state !== "unknown") continue;
      const address = /^[^:]+:(t\d+)$/.exec(task.endpoint?.target ?? "")?.[1];
      if (!address) continue;
      const r = await exec("hc", ["get", address, "--json"]);
      if (r.code !== 0) continue;
      const terminal = JSON.parse(r.stdout);
      // An address can be reused, so the terminal must still carry this task's label.
      if (terminal.labels?.["firstmate.task"] === `fm-${task.id}`) task.core_status = terminal.status?.state;
    }
  }

  async loadSnapshot() {
    const file = props()?.snapshot_file;
    if (file) return JSON.parse(await readTextFile(file));
    const r = await this.fm("fm-fleet-snapshot.sh", ["--json"]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `snapshot exited ${r.code}`);
    return JSON.parse(r.stdout);
  }

  async loadInbox() {
    const receipts = await this.fm("fm-inbox.sh", ["receipts", "--all-pending"]);
    const ready = await this.fm("fm-inbox.sh", ["ready"]);
    if (receipts.code === 0) {
      const { pending = [] } = JSON.parse(receipts.stdout);
      this.requests = pending.filter((n) => n.request_id?.startsWith("board-"));
    }
    this.ready = ready.code === 0 ? JSON.parse(ready.stdout).can_receive : null;
    this.beat = ready.code === 0 ? JSON.parse(ready.stdout).wake_consumer?.beacon_age_seconds ?? null : null;
    await this.loadWatchers();
  }

  // Firstmate's supervision processes, read from the home's own runtime records:
  // the supervision host and its arm (state/.supervision-host) and the watcher
  // holding state/.watch.lock. ps confirms each pid is alive and how long it has run.
  async loadWatchers() {
    const roles = [];
    try {
      for (const line of (await readTextFile(`${home()}/state/.supervision-host`)).split("\n")) {
        const [role, pid] = line.split("\t");
        if ((role === "host" || role === "arm") && /^\d+$/.test(pid ?? "")) roles.push({ role: role === "host" ? "Host" : "Arm", pid });
      }
    } catch {}
    try {
      const pid = (await readTextFile(`${home()}/state/.watch.lock/pid`)).trim();
      if (/^\d+$/.test(pid)) roles.push({ role: "Watcher", pid });
    } catch {}
    if (!roles.length) { this.watchers = []; return; }
    const r = await exec("ps", ["-o", "pid=,etime=", "-p", roles.map((x) => x.pid).join(",")]);
    const alive = new Map((r.stdout ?? "").trim().split("\n").filter(Boolean)
      .map((l) => l.trim().split(/\s+/)).map(([pid, etime]) => [pid, etime]));
    this.watchers = roles.map((x) => ({ ...x, up: alive.get(x.pid) ?? null }));
  }

  send(text, cx, after) {
    cx.spawn(async (cx) => {
      const r = await this.fm("fm-inbox.sh", ["note", "--json", "--request-id", `board-${Date.now()}`, "--", text]);
      // 3 means saved but not announced: the request exists and firstmate sees it at its next drain.
      if (r.code === 0 || r.code === 3) { this.notice = "Request sent"; after?.(); }
      else this.notice = `Request failed: ${r.stderr.trim() || r.code}`;
      this.last = 0; this.refresh(cx);
      cx.notify();
    });
  }

  // A chosen folder prefers its origin, so the project stays linked to the real remote.
  usePath(path, cx) {
    cx.spawn(async (cx) => {
      const top = await exec("git", ["-C", path, "rev-parse", "--show-toplevel"]);
      if (top.code !== 0) { this.notice = "Not a git repository"; cx.notify(); return; }
      const folder = top.stdout.trim();
      const origin = (await exec("git", ["-C", folder, "remote", "get-url", "origin"]));
      const remote = origin.code === 0 ? origin.stdout.trim() : "";
      this.picked = { folder, remote };
      this.source.set_value(remote || folder);
      this.name.set_value(base(folder));
      this.mode = remote ? MODES[0].id : "local-only";
      this.notice = "";
      cx.notify();
    });
  }

  pick(cx) {
    cx.spawn(async (cx) => {
      const path = await pickFolder({ prompt: "Repository folder to add as a project" });
      if (path) this.usePath(path, cx);
    });
  }

  submitAdd(cx) {
    const source = this.source.value().trim(), name = this.name.value().trim();
    const local = this.picked && source === (this.picked.remote || this.picked.folder);
    if (!source || (!local && /\s/.test(source))) { this.notice = "Check the repository URL"; cx.notify(); return; }
    if (/[\r\n]/.test(name)) { this.notice = "Check the name"; cx.notify(); return; }
    const from = local ? ` local_folder="${this.picked.folder}"` : "";
    this.send(`[Board request] Add project: source="${source}"${from} name=${name || "(from URL)"} posture=${this.mode}`, cx, () => {
      this.adding = false; this.picked = null; this.source.set_value(""); this.name.set_value("");
    });
  }

  submitRemove(name, cx) {
    this.send(`[Board request] Remove project from firstmate: name=${name}. Remove only the registry entry and local clone, leave the remote untouched. Stop and report if the preflight finds work or unlanded changes.`, cx, () => {
      this.confirm = null;
    });
  }

  button(id, label, t, onClick, strong) {
    return div().id(id).px(6).py(2).rounded(5).cursor_pointer().text_size(fs(11))
      .text_color(strong ? t.solid_foreground : t.muted).bg(strong ? t.solid : t.raised)
      .hover((s) => s.opacity(0.8)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  field(state, t) {
    return Input.new(state).h(28).px(8).rounded(6).border_1().border_color(t.input)
      .bg(t.background).text_size(fs(12)).text_color(t.foreground);
  }

  addForm(t) {
    return v_flex().gap(6).p(8).rounded(6).bg(t.background)
      .child(h_flex().gap(4).items_center()
        .child(div().flex_1().min_w(0).child(this.field(this.source, t)))
        .child(this.button("add-pick", "Choose folder", t, (cx) => this.pick(cx))))
      .child(this.field(this.name, t))
      .when(Boolean(this.picked), (el) => el.child(div().text_size(fs(11)).text_color(t.dim).child(
        this.picked.remote ? `${this.picked.folder} · clones from remote`
          : `${this.picked.folder} · no remote, clones from this folder`)))
      .child(h_flex().gap(4).flex_wrap().children(MODES.map((m) =>
        div().id(`mode-${m.id}`).px(6).py(2).rounded(5).cursor_pointer().text_size(fs(11))
          .bg(this.mode === m.id ? t.selected : t.raised)
          .text_color(this.mode === m.id ? t.foreground : t.muted)
          .on_click((_e, cx) => { this.mode = m.id; cx.notify(); }).child(m.label))))
      .child(h_flex().gap(4)
        .child(this.button("add-send", "Request add", t, (cx) => this.submitAdd(cx), true))
        .child(this.button("add-cancel", "Cancel", t, (cx) => { this.adding = false; cx.notify(); })));
  }

  projectRow(p, t) {
    const open = this.open.has(p.name);
    const mine = (this.cards ?? []).filter((c) => c.project === p.name);
    const counts = COLUMNS.filter((c) => c.id !== "done")
      .map((c) => [c.title, mine.filter((m) => m.column === c.id).length])
      .filter(([, n]) => n > 0).map(([title, n]) => `${title} ${n}`).join(" · ");
    const row = v_flex().gap(4)
      .child(h_flex().id(`project-${p.name}`).gap(6).items_center().cursor_pointer()
        .hover((s) => s.opacity(0.75))
        .on_click((_e, cx) => { if (!this.open.delete(p.name)) this.open.add(p.name); cx.notify(); })
        .child(div().text_size(fs(10)).text_color(t.dim).child(open ? "▾" : "▸"))
        .child(this.projectBadge(p.name, t, `ptag-${p.name}`))
        .child(div().flex_1().min_w(0).truncate().text_size(fs(12)).text_color(t.foreground).child(p.name))
        .child(div().flex_none().text_size(fs(11)).text_color(t.dim)
          .child(counts || "No tasks"))
        .child(this.viewButton(p.name, t)));
    if (!open) return row;
    row.child(div().text_size(fs(11)).text_color(t.muted).child(p.desc))
      .child(div().text_size(fs(11)).text_color(t.dim)
        .child(`${modeLabel(p.mode)} · Auto-merge ${p.yolo ? "on" : "off"}`))
      .child(this.colorPicker(p.name, t));
    if (this.confirm === p.name) {
      return row.child(div().text_size(fs(11)).text_color(t.foreground)
          .child("Removes the registry entry and local clone. The remote repository stays."))
        .child(h_flex().gap(4)
          .child(this.button(`rm-yes-${p.name}`, "Request removal", t, (cx) => this.submitRemove(p.name, cx), true))
          .child(this.button(`rm-no-${p.name}`, "Cancel", t, (cx) => { this.confirm = null; cx.notify(); })));
    }
    return row.child(h_flex().gap(4).flex_wrap()
      .child(this.button(`view-${p.name}`, this.filter === p.name ? "Show all" : "Show on board", t, (cx) => {
        this.filter = this.filter === p.name ? null : p.name; cx.notify();
      }))
      .child(this.button(`dir-${p.name}`, "Open folder", t, () => { exec("open", [`${home()}/projects/${p.name}`]); }))
      .child(this.button(`rm-${p.name}`, "Remove from firstmate", t, (cx) => { this.confirm = p.name; cx.notify(); })));
  }

  requestRow(n, t) {
    const body = n.body.replace(/^\[Board (?:요청|request)\]\s*/, "").split(/ source=| local_folder=| name=|\. /).slice(0, 2).join(" ");
    return h_flex().gap(6).child(div().flex_1().min_w(0).text_size(fs(11)).text_color(t.muted).truncate().child(body))
      .child(div().flex_none().text_size(fs(11)).text_color(t.dim).child("Pending"));
  }

  // The same card look as Herdr's panes.
  frame(el, t) {
    return el.p(8).rounded(10).bg(t.background).border(1).border_color(t.border);
  }

  projectSection(t) {
    const collapsed = this.collapsed.has(PROJECTS);
    const header = h_flex().gap(6).items_center().px(6).py(4).rounded(5).bg(t.selected)
      .child(h_flex().id("head-projects").flex_1().gap(6).items_center().cursor_pointer()
        .hover((s) => s.opacity(0.75)).on_click((_e, cx) => this.toggle(PROJECTS, cx))
        .child(div().text_size(fs(10)).text_color(t.dim).child(collapsed ? "▸" : "▾"))
        .child(div().text_size(fs(12)).font_semibold().text_color(t.foreground).child("Projects"))
        .child(div().text_size(fs(11)).text_color(t.dim).child(String(this.projects.length))))
      .child(this.button("add-open", "+ Add", t, (cx) => {
        this.adding = !this.adding; this.collapsed.delete(PROJECTS); cx.notify();
      }));
    const el = this.frame(v_flex().flex_none().gap(8), t).child(header);
    if (collapsed) return el;
    const list = v_flex().id("project-list").gap(8).max_h(260).overflow_y_scrollbar();
    if (this.adding) list.child(this.addForm(t));
    list.children(this.projects.map((p) => this.projectRow(p, t)));
    if (this.requests.length) list.child(v_flex().gap(4).pt(6).border_t(1).border_color(t.border)
      .children(this.requests.map((n) => this.requestRow(n, t))));
    return el.child(list);
  }

  // Resolve the session for both submitted requests and editable card drafts.
  // When its terminal cannot be proven, leave a Board request for the next drain.
  async firstmateTerminal() {
    try {
      if (!home()) return null;
      // Inspect on every send: a stale PID can be reused by an unrelated process.
      const ready = await this.fm("fm-inbox.sh", ["ready"]);
      if (ready.code !== 0) return null;
      const { lock } = JSON.parse(ready.stdout);
      if (lock?.state !== "held" || lock.live_harness !== true) return null;
      const holder = lock.pid;
      if (!Number.isSafeInteger(holder) || holder <= 1) return null;
      const r = await exec("hc", ["ls", "--json"]);
      if (r.code !== 0) return null;
      const live = [];
      for (const { address, state } of JSON.parse(r.stdout).terminals ?? []) {
        if (state !== "live") continue;
        const detail = await exec("hc", ["get", address, "--json"]);
        if (detail.code !== 0) continue;
        const terminal = JSON.parse(detail.stdout);
        if (terminal.state !== "live") continue;
        if (terminal.foreground?.pid === holder) return address;
        live.push({ address, pid: terminal.pid });
      }
      // Other primaries may put a wrapper in the foreground. Prove ancestry
      // only when no foreground PID matched; launch cwd and agent names can drift.
      const seen = new Set();
      let pid = holder;
      while (pid > 1 && !seen.has(pid)) {
        seen.add(pid);
        const parent = await exec("ps", ["-o", "ppid=", "-p", String(pid)]);
        if (parent.code !== 0 || !/^\d+$/.test(parent.stdout.trim())) return null;
        pid = Number(parent.stdout.trim());
        const terminal = live.find((x) => x.pid === pid);
        if (terminal) return terminal.address;
      }
    } catch {}
    return null;
  }

  // One line only: a newline would submit the message early.
  typeToFirstmate(text, fallback, done, cx, after, insertOnly = false) {
    const line = insertOnly ? text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim() + " "
      : text.replace(/\s*\n\s*/g, " ").trim();
    cx.spawn(async (cx) => {
      let terminal = null;
      try { terminal = await this.firstmateTerminal(); } catch {}
      if (!terminal) {
        this.send(fallback, cx, after);
        this.notice = "Could not find the firstmate terminal: left as a request"; cx.notify(); return;
      }
      try {
        if (insertOnly) await this.pasteToFirstmate(terminal, line, cx);
        else {
          const r = await exec("hc", ["send", terminal, line, "--json"]);
          if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || String(r.code));
        }
        this.notice = done; after?.();
      } catch (e) { this.notice = `Could not type into firstmate: ${e instanceof Error ? e.message : String(e)}`; }
      cx.notify();
    });
  }

  // Paste has a different lifecycle from hc send: focus, insert without Enter,
  // then restore clipboard text after Herdr has had time to consume it.
  // Clipboard tools otherwise fall back to a legacy encoding in GUI environments.
  /** @param {string} terminal @param {string} line @param {import("gpui-kit").AsyncContext} cx */
  async pasteToFirstmate(terminal, line, cx) {
    if (this.pasting) throw new Error("A card is already being inserted; try again");
    this.pasting = true;
    let saved = null;
    /** @param {string} text */
    const copy = (text) => exec("/usr/bin/env", ["LC_ALL=en_US.UTF-8", "sh", "-c", "printf '%s' \"$1\" | pbcopy", "board-clipboard", text]);
    try {
      run("agent.focus", { terminal });
      await new Promise((resolve) => cx.timer.after(100, () => resolve(null)));
      if (focused()?.terminal !== terminal) throw new Error("Could not focus the firstmate terminal");
      const previous = await exec("/usr/bin/env", ["LC_ALL=en_US.UTF-8", "pbpaste"]);
      if (previous.code !== 0) throw new Error("Could not save clipboard text");
      saved = previous.stdout;
      const copied = await copy(line);
      if (copied.code !== 0) throw new Error("Could not copy the card text");
      // Focus may have changed while the clipboard command was running.
      if (focused()?.terminal !== terminal) throw new Error("Firstmate terminal focus changed; try again");
      run("terminal.paste");
      await new Promise((resolve) => cx.timer.after(300, () => resolve(null)));
    } finally {
      try {
        if (saved !== null) {
          const restored = await copy(saved);
          if (restored.code !== 0) throw new Error("Could not restore clipboard text");
        }
      } finally { this.pasting = false; }
    }
  }

  /** @param {string} text @param {string} fallback @param {import("gpui-kit").Context} cx */
  insertCardText(text, fallback, cx) {
    this.typeToFirstmate(text, fallback, "Text is in the firstmate input, waiting for Enter", cx, undefined, true);
  }

  /** @param {string} key @param {string[]} ids @param {string} title @param {Record<string, `#${string}`>} t */
  askButton(key, ids, title, t) {
    return div().id(`ask-card-${key}`).flex_none().p(3).rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip("Ask firstmate about this task")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.insertCardText(`[Board card] ${ids.join(", ")}: ${title}`,
          `[Board request] Ask about ${ids.join(", ")}: ${title}`, cx);
      })
      .child(div().w(fs(14)).h(fs(14)).rounded(fs(7)).border(1).border_color(t.muted)
        .flex().items_center().justify_center().text_size(fs(11)).text_color(t.muted).child("?"));
  }

  typeCommand(command, cx) {
    this.typeToFirstmate(command, `[Board request] Run ${command}`, `Typed ${command} into firstmate`, cx);
  }

  commandSection(t) {
    const collapsed = this.collapsed.has(COMMANDS);
    const el = this.frame(v_flex().flex_none().gap(8), t)
      .child(h_flex().id("head-commands").gap(6).items_center().px(6).py(4).rounded(5).bg(t.selected)
        .cursor_pointer().hover((s) => s.opacity(0.75)).on_click((_e, cx) => this.toggle(COMMANDS, cx))
        .child(div().text_size(fs(10)).text_color(t.dim).child(collapsed ? "▸" : "▾"))
        .child(div().text_size(fs(12)).font_semibold().text_color(t.foreground).child("Commands")));
    if (collapsed) return el;
    const run = (command) => (cx) => this.typeCommand(command, cx);
    const request = (kind) => (cx) => {
      const text = this.ask.value().trim();
      if (!text) { this.notice = "Type what to investigate or do"; cx.notify(); return; }
      const project = this.askProject ?? "(firstmate picks)";
      this.typeToFirstmate(`[Board ${kind}] project=${project}: ${text}`,
        `[Board request] New ${kind}: project=${project} - ${text}`, `${kind === "scout" ? "Scout" : "Task"} request typed into firstmate`,
        cx, () => { this.ask.set_value(""); this.askProject = null; });
    };
    const chip = (name) => {
      const on = this.askProject === name;
      return div().id(`ask-${name}`).flex_none().rounded(9).border(2).border_color(on ? t.foreground : t.surface)
        .cursor_pointer().hover((s) => s.opacity(0.75))
        .on_click((_e, cx) => { this.askProject = on ? null : name; cx.notify(); })
        .child(this.projectBadge(name, t, `ask-tag-${name}`));
    };
    return el
      .child(h_flex().gap(4).flex_wrap()
        .child(this.button("cmd-bearings", "Bearings", t, run("/bearings"))
          .tooltip("Status report: decisions waiting, finished, in progress, and next up"))
        .child(this.button("cmd-ahoy", "Ahoy", t, run("/ahoy"))
          .tooltip("Catch up on what you missed and walk through waiting decisions one by one"))
        .child(this.button("cmd-stow", "Stow", t, run("/stow"))
          .tooltip("Save what this session learned and file its open work"))
        .child(this.button("cmd-quiet", "Quiet", t, run("/quiet"))
          .tooltip("Quiet mode: only decisions, ready PRs, failures, and logins reach you while you stay"))
        .child(this.button("cmd-quiet-off", "Quiet off", t, run("/quiet off"))
          .tooltip("Leave quiet mode and get routine updates again"))
        .child(this.button("cmd-afk", "AFK", t, run("/afk"))
          .tooltip("Away mode: work continues and a return brief waits for your next message"))
        .child(this.button("cmd-update", "Update", t, run("/updatefirstmate"))
          .tooltip("Update firstmate to the latest version; new rules apply from the next firstmate session")))
      .child(h_flex().gap(4).items_center()
        .child(div().flex_1().min_w(0).child(this.field(this.ask, t)))
        .child(this.button("ask-scout", "Scout", t, request("scout"), true)
          .tooltip("Request an investigation that produces a report, not a code change"))
        .child(this.button("ask-task", "Task", t, request("task"), true)
          .tooltip("Request a change to the project, delivered as a PR or branch")))
      .child(h_flex().gap(4).items_center().flex_wrap()
        .child(div().flex_none().text_size(fs(11)).text_color(t.dim).child(this.askProject ? "Project" : "Project (optional)"))
        .children(this.projects.map((p) => chip(p.name))));
  }

  card(c, t, inGroup) {
    // A search shows matching cards open, without changing the remembered folds.
    const foldId = `card:${c.id}`, folded = this.folded.has(foldId) && !this.query;
    const current = this.query && this.currentMatch === c.id;
    // A queued card that still waits on other work is dimmed and says what it waits on.
    const waiting = c.column === "queued" && c.waitingOn.length > 0;
    const badge = c.prWaiting ? div().flex_none().text_size(fs(11)).font_semibold().text_color(t.blocked).child("PR waiting") : null;
    const el = v_flex().id(`card-${c.id}`).gap(4).p(8).rounded(6).bg(t.background)
      .border(current ? 2 : 1).border_color(current ? t.accent : t.border).when(waiting && !current, (e) => e.opacity(0.6))
      .child(this.foldRow(foldId, t, folded, c.title, badge)
        .child(this.askButton(foldId, [c.id], c.title, t)));
    if (folded) return el;
    // The project sits on the state row so the title keeps the full card width.
    el.child(h_flex().gap(6).items_center().min_w(0)
      .child(this.projectBadge(c.project || "firstmate", t, `tag-${c.id}`))
      .when(c.priority !== null && c.column !== "done", (e) => e.child(div().flex_none().px(4).rounded(4).border(1)
        .border_color(c.priority === 0 ? t.foreground : t.border).text_size(fs(10))
        .text_color(c.priority === 0 ? t.foreground : t.muted).tooltip("Backlog priority, 0 is highest").child(`P${c.priority}`)))
      .child(div().flex_1().min_w(0).text_size(fs(11)).text_color(t.muted).truncate().child(waiting ? "waiting" : c.state)));
    if (waiting) {
      const key = `chain:${c.id}`, shown = this.chainOpen.has(key);
      el.child(div().id(`wait-${c.id}`).min_w(0).text_size(fs(11)).text_color(t.blocked).truncate()
        .cursor_pointer().hover((st) => st.opacity(0.75))
        .tooltip(shown ? "Hide the order" : "Show the order this task waits on")
        .on_click((_e, cx) => { if (!this.chainOpen.delete(key)) this.chainOpen.add(key); cx.notify(); })
        .child(`${shown ? "▾" : "▸"} ${waitingLabel(c)}`));
      if (shown) el.child(this.chain(c, t));
    }
    if (c.detail && !inGroup) el.child(div().text_size(fs(11)).text_color(t.dim).child(c.detail.slice(0, 140)));
    const ownDecision = c.decision && !c.decision.topic;
    if (ownDecision) this.decisionLines(el, c.decision, t, `card:${c.id}`, [c.id]);
    if (c.pr && /^https:\/\//.test(c.pr)) {
      el.child(div().id(`pr-${c.id}`).text_size(fs(11)).text_color(t.accent).truncate()
        .hover((s) => s.text_color(t.foreground))
        .on_click(() => { exec("open", [c.pr]); })
        .child(c.pr.replace("https://github.com/", "")));
    }
    const live = c.column !== "done";
    if (live && (c.terminal || c.worktree)) {
      const row = h_flex().gap(4);
      if (c.terminal) row.child(this.button(`open-${c.id}`, "Open worker", t, (cx) => this.openWorker(c, cx)));
      if (c.worktree && c.project) row.child(this.button(`files-${c.id}`, "Files · Changes", t, (cx) =>
        this.openView(c.project, { path: c.worktree, label: c.id, title: `${c.project} · ${c.id}` }, cx)));
      el.child(row);
    }
    return el;
  }

  // Options become editable chat drafts; the owner confirms them with Enter.
  /** @param {string[]} ids */
  decisionLines(el, decision, t, key, ids) {
    for (const o of decision.options) {
      el.child(h_flex().id(`opt-${key}-${o.label}`).gap(6).px(4).py(2).rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip("Put this answer in the firstmate input")
        .on_click((_e, cx) => {
          const answer = `${o.label} (${o.text})`;
          this.insertCardText(`[Board answer] ${ids.join(", ")}: ${answer}`,
            `[Board request] Captain's answer for ${ids.join(", ")}: ${answer}`, cx);
        })
        .child(div().flex_none().text_size(fs(11)).font_semibold().text_color(t.accent).child(o.label))
        .child(div().flex_1().min_w(0).text_size(fs(11)).text_color(t.foreground).child(o.text)));
    }
    if (decision.recommended) el.child(div().text_size(fs(11)).text_color(t.muted).child(`Recommended: ${decision.recommended}`));
    return el;
  }

  // A project's local copy plus each live worker's isolated copy of it.
  viewSources(project) {
    const local = { path: `${home()}/projects/${project}`, label: "local copy", title: `${project} · local copy` };
    const workers = (this.cards ?? []).filter((c) => c.project === project && c.worktree && c.column !== "done")
      .map((c) => ({ path: c.worktree, label: c.id, title: `${project} · ${c.id}` }));
    return [local, ...workers];
  }

  // The icon at the right end of a project's title row: opens that project's Files/Changes,
  // switches to it from another project, or closes it when it is already shown.
  // It stops the click so the row itself does not fold or unfold.
  viewButton(project, t) {
    const shown = Boolean(this.viewer.root) && this.viewProject === project;
    const stop = (_e, cx) => cx.stop_propagation();
    return div().id(`files-${project}`).flex_none().p(3).rounded(5).cursor_pointer()
      .when(shown, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .tooltip(shown ? "Close Files · Changes" : "Files · Changes")
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (shown) this.viewer.close(cx);
        else this.openView(project, this.viewSources(project)[0], cx);
      })
      .child(svg("mods/files/folder.svg").size(fs(14)).text_color(shown ? t.foreground : t.muted));
  }

  openView(project, source, cx) {
    this.viewProject = project;
    this.viewer.target(source.path, source.title, cx);
  }

  // The terminal must still carry this task's label: hc can reuse an address.
  openWorker(c, cx) {
    cx.spawn(async (cx) => {
      const r = await exec("hc", ["get", c.terminal, "--json"]);
      const label = r.code === 0 ? JSON.parse(r.stdout).labels?.["firstmate.task"] : null;
      if (label === `fm-${c.id}`) { run("agent.focus", { terminal: c.terminal }); this.notice = ""; }
      else this.notice = "Worker terminal not found";
      cx.notify();
    });
  }

  // The order a waiting task depends on, drawn top-down: every unfinished task it waits on,
  // grouped by how deep it sits in the chain, an arrow between levels, and the task itself
  // last. Each step shows its live state, so the first thing that is actually moving is plain.
  chain(c, t) {
    const byId = new Map((this.cards ?? []).map((x) => [x.id, x]));
    const ancestors = new Set();
    const collect = (id) => {
      for (const up of byId.get(id)?.waitingIds ?? []) if (!ancestors.has(up)) { ancestors.add(up); collect(up); }
    };
    collect(c.id);
    const depth = new Map();
    const level = (id, path = new Set()) => {
      if (depth.has(id)) return depth.get(id);
      if (path.has(id)) return 0; // a cycle in the records; never loop
      path.add(id);
      const ups = (byId.get(id)?.waitingIds ?? []).filter((u) => ancestors.has(u));
      const d = ups.length ? 1 + Math.max(...ups.map((u) => level(u, path))) : 0;
      depth.set(id, d);
      return d;
    };
    const levels = [];
    for (const id of ancestors) (levels[level(id)] ??= []).push(id);
    const strip = (title) => (c.project && title.startsWith(`${c.project} `) ? title.slice(c.project.length + 1) : title);
    const status = (x) => {
      if (!x) return ["finished or unknown", t.muted];
      if (x.column === "queued") return x.waitingIds.length ? ["waiting", t.blocked] : ["ready", t.foreground];
      const col = COLUMNS.find((k) => k.id === x.column);
      return [x.column === "working" ? "working" : (x.state || x.column), t[col?.color] ?? t.muted];
    };
    const step = (id, self) => {
      const x = byId.get(id);
      const [label, color] = self ? ["this task", t.accent] : status(x);
      return h_flex().gap(6).items_center().min_w(0)
        .child(div().flex_none().w(6).h(6).rounded(3).bg(color))
        .child(div().flex_1().min_w(0).text_size(fs(11)).truncate()
          .text_color(self ? t.foreground : t.dim).when(self, (e) => e.font_semibold())
          .child(strip(x?.title ?? id)))
        .child(div().flex_none().text_size(fs(10)).text_color(color).child(label));
    };
    const arrow = () => div().pl(1).text_size(fs(11)).text_color(t.muted).child("↓");
    const box = v_flex().gap(2).p(6).rounded(5).bg(t.raised).border(1).border_color(t.border);
    levels.filter(Boolean).forEach((ids, i) => {
      if (i) box.child(arrow());
      box.child(v_flex().gap(2).children(ids.map((id) => step(id, false))));
    });
    return box.child(arrow()).child(step(c.id, true));
  }

  // One box per topic: the question and its options once, then every task it decides.
  group(topic, cards, t) {
    const foldId = `group:${topic}`, folded = this.folded.has(foldId) && !this.query;
    const first = cards.find((c) => c.decision.options.length) ?? cards[0];
    const ids = cards.map((c) => c.id), question = first.decision.question || topic;
    const box = v_flex().id(`group-${topic}`).gap(6).p(8).rounded(6).bg(t.raised).border(1).border_color(t.accent)
      .child(this.foldRow(foldId, t, folded, question,
        div().flex_none().text_size(fs(11)).text_color(t.dim).child(String(cards.length)))
        .child(this.askButton(foldId, ids, question, t)));
    if (folded) return box;
    this.decisionLines(box, first.decision, t, `group:${topic}`, ids);
    return box.children(cards.map((c) => this.card(c, t, true)));
  }

  // A column's entries in drawing order: a card, or a topic group at its first card's place.
  entries(cards) {
    const groups = new Map(), out = [];
    for (const c of cards) {
      const topic = c.decision?.topic;
      if (!topic) { out.push({ card: c }); continue; }
      if (!groups.has(topic)) { groups.set(topic, []); out.push({ topic, cards: groups.get(topic) }); }
      groups.get(topic).push(c);
    }
    return out;
  }

  items(cards, t) {
    return this.entries(cards).map((x) => (x.topic ? this.group(x.topic, x.cards, t) : this.card(x.card, t)));
  }

  // Matching card ids in the order the board draws them: columns left to right, then down each column.
  matchIds() {
    return this.shownColumns().flatMap((col) => this.entries(this.cardsIn(col.id))
      .flatMap((x) => (x.topic ? x.cards : [x.card])).map((c) => c.id));
  }

  shownColumns() {
    return COLUMNS.filter((c) => !c.optional || this.cardsIn(c.id).length);
  }

  // The first Enter or find click applies the typed text; repeating it with the same text steps on.
  findNext(cx) {
    const text = this.search.value().trim();
    if (!text) { this.clearSearch(cx); return; }
    if (text === this.query) this.matchAt += 1;
    else { this.query = text; this.matchAt = 0; }
    cx.notify();
  }

  clearSearch(cx) {
    this.query = ""; this.matchAt = 0;
    if (this.search.value()) this.search.set_value("");
    cx.notify();
  }

  // The top of the Kanban section: the field, the find icon, and where the current match sits.
  searchRow(t, matches) {
    const count = !this.query ? null : matches.length ? `${this.matchAt % matches.length + 1}/${matches.length}` : "No matches";
    return h_flex().id("kanban-search").flex_none().gap(4).items_center()
      .on_key_down((e, cx) => {
        if (e.key === "escape" && (this.query || this.search.value())) { this.clearSearch(cx); cx.stop_propagation(); }
      })
      .child(div().flex_1().min_w(0).child(this.field(this.search, t)))
      .child(div().id("search-find").flex_none().p(5).rounded(5).cursor_pointer().bg(t.raised)
        .hover((s) => s.bg(t.hover)).tooltip("Find next (Enter) · Esc clears")
        .on_click((_e, cx) => this.findNext(cx))
        .child(svg("mods/workspace-chrome/search.svg").size(fs(14)).text_color(t.muted)))
      .when(count !== null, (el) =>
        el.child(div().flex_none().text_size(fs(11)).text_color(matches.length ? t.muted : t.blocked).child(count)));
  }

  cardsIn(id) {
    const all = (this.cards ?? []).filter((c) => c.column === id && (!this.filter || c.project === this.filter));
    // Highest priority first; equal or unset priorities keep backlog order (sort is stable).
    const rank = (c) => c.priority ?? Infinity;
    const shown = id === "done" ? all.slice(-DONE_LIMIT).reverse() : all.sort((a, b) => rank(a) - rank(b));
    const q = this.query.toLowerCase();
    return q ? shown.filter((c) => searchText(c).includes(q)) : shown;
  }

  column(col, t, stacked) {
    const cards = this.cardsIn(col.id);
    // A collapsed column that holds a match opens while the search lasts.
    const collapsed = this.collapsed.has(col.id) && !(this.query && cards.length);
    const header = h_flex().id(`head-${col.id}`).gap(6).items_center().cursor_pointer()
      .hover((s) => s.opacity(0.75))
      .on_click((_e, cx) => { if (!this.query) this.toggle(col.id, cx); })
      .child(div().text_size(fs(10)).text_color(t.dim).child(collapsed ? "▸" : "▾"))
      .child(div().w(8).h(8).rounded(4).bg(t[col.color]));
    if (collapsed && !stacked) {
      return v_flex().id(`col-${col.id}`).w(36).h_full().p(8).gap(6).rounded(8).bg(t.surface).items_center()
        .child(header)
        .child(div().text_size(fs(11)).text_color(t.dim).child(String(cards.length)))
        .child(v_flex().items_center().children([...col.title].map((letter) =>
          div().text_size(fs(11)).font_semibold().text_color(t.foreground).child(letter))));
    }
    header.px(6).py(4).rounded(5).bg(t.selected)
      .child(div().text_size(fs(12)).font_semibold().text_color(t.foreground).child(col.title))
      .child(div().text_size(fs(11)).text_color(t.dim).child(String(cards.length)));
    const el = v_flex().id(`col-${col.id}`).min_w(0).gap(8).p(8).rounded(8).bg(t.surface).child(header);
    if (!stacked) el.flex_1().h_full();
    else el.flex_none(); // stacked columns keep their height; the board scrolls as one list
    if (collapsed) return el;
    const list = v_flex().id(`list-${col.id}`).gap(6).children(this.items(cards, t));
    return el.child(stacked ? list : list.flex_1().min_h(0).overflow_y_scrollbar());
  }

  // The same tag on project rows and cards; hovering shows the full project name.
  projectBadge(name, t, id) {
    const color = this.colorOf(name, t);
    const tag = this.tags?.get(name) ?? name.slice(0, 3).toUpperCase();
    // A fixed width (scaled with the text) keeps every tag the same size, whatever its letters.
    return h_flex().id(id).flex_none().w(fs(38)).justify_center().py(1).rounded(9).bg(color)
      .text_size(fs(11)).font_semibold().text_color("#ffffff").tooltip(name).child(tag);
  }

  badge(label, color) {
    return div().flex_none().px(6).py(1).rounded(5).border(1).border_color(color).text_size(fs(11)).text_color(color).child(label);
  }

  // One chip per supervision process: a dot (alive or gone), the role, and how long it
  // has run; the watcher chip adds the age of its last heartbeat beacon.
  watcherChips(t) {
    const list = this.watchers ?? [];
    if (!list.length) return [this.badge("No watcher", t.ansi1)];
    const short = (etime) => { // ps etime [[dd-]hh:]mm:ss -> 17m, 2h05m, 3d
      const [d, rest] = etime.includes("-") ? etime.split("-") : [null, etime];
      const p = rest.split(":").map(Number); const [h, m] = p.length === 3 ? [p[0], p[1]] : [0, p[0]];
      return d ? `${d}d` : h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
    };
    return list.map((w) => {
      const stale = w.role === "Watcher" && this.beat !== null && this.beat > 120;
      const color = !w.up ? t.ansi1 : stale ? t.working : t.ansi2;
      const label = !w.up ? `${w.role} down` : w.role === "Watcher" && this.beat !== null
        ? `${w.role} ${short(w.up)} · beat ${this.beat}s` : `${w.role} ${short(w.up)}`;
      return h_flex().id(`watch-${w.role}`).flex_none().gap(4).items_center()
        .tooltip(`${w.role} pid ${w.pid}${w.up ? `, running ${w.up}` : ", not running"}`)
        .child(div().w(6).h(6).rounded(3).bg(color))
        .child(div().text_size(fs(11)).text_color(w.up ? t.dim : t.ansi1).child(label));
    });
  }

  footer(t) {
    const text = (value) => div().min_w(0).text_size(fs(11)).text_color(t.dim).truncate().child(value);
    const right = h_flex().flex_none().gap(6).items_center().min_w(0);
    if (this.error) right.child(text(this.error)).child(this.badge("Update failed", t.ansi1));
    else if (!this.cards) right.child(text("Loading"));
    else {
      right.child(text([this.notice, `Updated ${koreaTime(this.generated)}`].filter(Boolean).join(" · ")));
      if (this.ready !== null) right.child(this.ready ? this.badge("Receiving", t.ansi2) : this.badge("Not receiving", t.working));
    }
    return h_flex().flex_none().gap(10).items_center().justify_between().min_w(0)
      .child(h_flex().flex_1().min_w(0).gap(10).items_center().overflow_hidden().children(this.watcherChips(t)))
      .child(right);
  }

  render(_cx) {
    readFontScale(this.size?.width);
    const names = [...this.projects.map((p) => p.name), ...(this.cards ?? []).map((c) => c.project).filter(Boolean)];
    this.tags = abbreviations(["firstmate", ...names]);
    this.autoColor = autoColors(names);
    const t = theme();
    if (!home()) return v_flex().id("home-required").size_full().bg(t.canvas).p(16)
      .child(v_flex().gap(8).p(16).rounded(8).bg(t.surface).border(1).border_color(t.border)
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child("Firstmate home required"))
        .child(div().text_size(13).text_color(t.muted).child("Set the home prop on this mod in your layout to the path of your firstmate home.")));
    const stacked = (this.size?.width ?? Infinity) < STACK_BELOW_PX;
    const matches = this.query ? this.matchIds() : [];
    this.currentMatch = matches.length ? matches[this.matchAt % matches.length] : null;
    const board = (stacked ? v_flex().id("board").overflow_y_scrollbar() : h_flex()).flex_1().min_h(0).gap(8)
      .children(this.shownColumns().map((c) => this.column(c, t, stacked)));
    const root = v_flex().id("root").size_full().bg(t.canvas).px(8).pt(2.5).pb(3).gap(6)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(this.projectSection(t));
    if (this.filter) {
      root.child(h_flex().gap(6).items_center()
        .child(div().text_size(fs(11)).text_color(t.muted).child(`Filter: ${this.filter}`))
        .child(this.button("filter-clear", "Clear", t, (cx) => { this.filter = null; cx.notify(); })));
    }
    root.child(this.frame(v_flex().flex_1().min_h(0).gap(6), t)
      .child(this.searchRow(t, matches)).child(board).child(this.footer(t)))
      .child(this.commandSection(t));
    if (!this.viewer.root) return root;
    // The viewer sits on the Board's right behind a draggable divider. Herdr keeps the
    // dragged width under the group id; the Board half keeps measuring its own width
    // so the columns still stack when that half gets narrow.
    return h_resizable("board-viewer-split").size_full().bg(t.canvas)
      .child(resizable_panel().size_range(280).child(root))
      .child(resizable_panel().size(this.viewerWidth()).size_range(260)
        .child(div().id("viewer-wrap").size_full().pl(4).pr(8).pt(2.5).pb(3)
          .child(this.viewer.render(t, fs, this.viewSources(this.viewProject)))));
  }

  // The starting width only: after the first drag Herdr keeps the user's width under
  // the group id. Half the Board when its width is known, else a readable default.
  viewerWidth() {
    const w = this.size?.width;
    return w ? Math.max(420, Math.round(w / 2)) : 560;
  }
}
