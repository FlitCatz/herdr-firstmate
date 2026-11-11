// Firstmate board: projects on top, tasks below. Fleet data comes from
// fm-fleet-snapshot.sh; this mod never changes it. Adding or removing a project
// only sends a note through fm-inbox.sh, and firstmate does the work under its
// project-management procedure. The Command buttons type their slash command
// into the open firstmate terminal through hc.
// props: { home, snapshot_file?, collapsed?, ui? }. home is the firstmate
// installation and operational home; the other props support preview fixtures.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, h_resizable, resizable_panel } from "gpui-base";
import { exec, pickFolder, props, readTextFile, watchFolder, theme, settings, run, focused, terminals } from "herdr";
import { FolderViewer } from "./viewer.js";

// Board text follows the terminal font size and grows as the Board widens. The sizes below
// were drawn for Herdr's default 14px terminal font. At the stacking width they keep that
// proportion to the terminal font; by GROW_FULL_PX the largest Board text (12px titles)
// reaches the terminal font size, which is the ceiling.
const DESIGN_FONT_PX = 14;
const LARGEST_TEXT_PX = 12;
const GROW_FULL_PX = 1600;
const REFRESH_FALLBACK_MS = 30000;
const MIN_GAP_MS = 2000;
// Shown worker cards repeat the last lines of their worker's screen, read this often.
const TAIL_REFRESH_MS = 4000;
const TAIL_READ_TIMEOUT_MS = 1500;
const TAIL_ROUND_LIMIT_MS = 10000;
const TAIL_READS_PER_TERMINAL = 2;
// A read still running after this long no longer counts toward TAIL_READS_PER_TERMINAL, so a
// terminal whose reads hung is read again within a minute of reads working again.
const TAIL_STALE_READ_MS = 60000;
const TAIL_LINES = 2;
// Worker terminals are checked for the worker's own running commands this often, all from one
// process listing.
const BACKGROUND_REFRESH_MS = 5000;
const PROCESS_LIST_TIMEOUT_MS = 3000;
const BACKGROUND_ROUND_LIMIT_MS = 10000;
// A listing still running after BACKGROUND_STALE_LISTING_MS no longer counts toward
// BACKGROUND_OPEN_LISTINGS, so listings start again within a minute of working again.
const BACKGROUND_OPEN_LISTINGS = 2;
const BACKGROUND_STALE_LISTING_MS = 60000;
const DONE_LIMIT = 20;
const STACK_BELOW_PX = 720; // narrower than this, columns stack as an accordion
const COLLAPSED_KEY = "collapsed";
const FOLDED_KEY = "folded";
const PROJECTS = "projects";
const COMMANDS = "commands";
// AppleScript names for clipboard images, file references, and RTFD, which can carry attachments.
// pbpaste and pbcopy keep only text, so other clipboards come back as plain text.
const IMAGE_OR_FILE_CLIPBOARD_TYPE = /picture|PNG|TIFF|JPEG|GIF|PDF|BMP|jp2|heic|8BPS|icns|RTFD|furl|file|alias|«class fss »/i;

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
// The Held column's groups, in drawing order. The snapshot's hold_bucket places a card: "dated"
// is deferred until hold_until, "blocked" waits on unfinished work, and every other card (a
// live or aged hold, or one with no bucket) is one to answer now.
const HOLD_GROUPS = [
  { id: "now", title: "Answer now" },
  { id: "deferred", title: "Deferred" },
  { id: "waiting", title: "Waiting on other work" },
];
const HOLD_GROUP_OF = { dated: "deferred", blocked: "waiting" };
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

// hc endpoints look like "default:t3x"; the part after the colon is the terminal address.
function hcAddress(task) {
  return /^[^:]+:(t[0-9a-z]+)$/.exec(task?.endpoint?.target ?? "")?.[1] ?? null;
}

// Escape sequences (CSI, OSC, and single-character escapes) and other control characters.
const ESCAPES = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Rows with nothing to read: rules, box edges, prompts, and spinner or bullet glyphs alone.
const DECORATION = /^[\s\u2500-\u25ff\u2700-\u27bf\u2800-\u28ff\u00b7\u2022\u2026\-=_*~|+.:;,<>\/\\#()[\]{}'"`^]*$/;

// A prompt row, bare or inside a box edge. Codex and Claude Code draw their input box at the
// bottom with only their status line and key hints below it.
const INPUT_ROW = /^[\u2502\u2503|]?\s*[\u203a\u276f>](?:\s|$)/;

// The last meaningful lines of a terminal screen above its input row, for display only.
/** @param {string} text @returns {string[]} */
function screenTail(text) {
  const lines = text.replace(ESCAPES, "").split(/\r?\n|\r/).map((line) => line.trim());
  let end = lines.length;
  while (end > 0 && !INPUT_ROW.test(lines[end - 1])) end--;
  return lines.slice(0, end ? end - 1 : lines.length)
    .filter((line) => line && !DECORATION.test(line)).slice(-TAIL_LINES).map((line) => line.slice(0, 400));
}

// Commands that count as a worker's own job when its terminal runs them. Only a known program
// counts: an agent keeps helpers such as tool servers running the whole time, so "any process
// under the terminal" would show every worker as busy.
const SHELL = /^(?:sh|bash|zsh|dash|ksh|fish)$/;
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|fish|node|bun|deno|python[\d.]*|ruby)$/;
const WORK_VERBS = new Map([
  ["test", "테스트"], ["vstest", "테스트"], ["build", "빌드"], ["msbuild", "빌드"], ["publish", "빌드"], ["pack", "빌드"],
  ["check", "검사"], ["typecheck", "검사"], ["format", "검사"], ["lint", "검사"], ["clippy", "검사"], ["vet", "검사"],
  ["restore", "설치"], ["install", "설치"], ["ci", "설치"],
]);
// Programs that take one of WORK_VERBS as their subcommand, and programs that are a job whatever their arguments.
const VERB_TOOLS = new Set(["dotnet", "npm", "pnpm", "yarn", "bun", "cargo", "go", "swift", "make"]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const WHOLE_TOOLS = new Map([
  ["no-mistakes", "no-mistakes 검증"], ["pytest", "pytest 테스트"], ["jest", "jest 테스트"], ["vitest", "vitest 테스트"],
  ["xcodebuild", "xcodebuild 빌드"], ["tsc", "tsc 빌드"],
]);
// A script named for what it does, such as check.sh, run-tests.sh, or lexer.test.sh.
const WORK_SCRIPT = /(?:^|[-_.])(?:tests?|check|lint|build|validate|verify)(?:[-_.]|$)/i;
const WAIT_LOOP = "sleep 대기";

// The short label of a process that is a worker's own job, from its command line; null otherwise.
/** @param {string} command @returns {string | null} */
function workLabel(command) {
  let [program, ...args] = command.trim().split(/\s+/);
  program = base(program);
  // An inline shell command that sleeps is a wait loop, such as polling CI until it finishes.
  // The shell counts rather than its sleep, so the label holds while the loop runs its check.
  if (SHELL.test(program) && /^-[a-z]*c$/.test(args[0] ?? "")) {
    const script = args.slice(1).join(" ").replaceAll("\\012", " "); // ps prints a newline as \012
    if (!/\bsleep\s/.test(script)) return null;
    return /\bgh(?:-axi)?\s+(?:run|pr)\s/.test(script) ? "CI 대기" : WAIT_LOOP;
  }
  // A script or tool started through its interpreter is named by its file, not the interpreter.
  const subcommand = VERB_TOOLS.has(program) && !/[./]/.test(args[0] ?? "");
  if (INTERPRETER.test(program) && args[0] && !args[0].startsWith("-") && !subcommand) { program = base(args[0]); args = args.slice(1); }
  if ((program === "gh" || program === "gh-axi") && /^(?:run watch|pr checks)$/.test(args.slice(0, 2).join(" "))) return "CI 대기";
  if (args.some((a) => /^--watch(?:All)?(?:=(?!false$|0$).*)?$/.test(a) || (program === "tsc" && a === "-w"))) return null;
  if (WHOLE_TOOLS.has(program)) return WHOLE_TOOLS.get(program) ?? null;
  if (program === "node" && args.includes("--test")) return "node 테스트";
  if (VERB_TOOLS.has(program)) {
    // The subcommand is the first word that is not an option; "npm run test:unit" names it after "run".
    // A package script, with or without "run", is named by the part before its first ":", unless a
    // later part names a watcher or server, as in "test:watch".
    // A build server's first word is a file path, so an idle MSBuild or compiler server never counts.
    const words = args.filter((a) => !/^[-+]/.test(a));
    const scripts = SCRIPT_RUNNERS.has(program);
    const name = (scripts && words[0] === "run" ? words[1] : words[0]) ?? "";
    const [verb, ...variants] = scripts ? name.split(":") : [name];
    if (variants.some((part) => /^(?:watch|dev|serve|start)$/.test(part))) return null;
    return WORK_VERBS.has(verb) ? `${program} ${WORK_VERBS.get(verb)}` : null;
  }
  return WORK_SCRIPT.test(program) ? program.slice(0, 40) : null;
}

// The job each terminal runs, by terminal address, from one "pid ppid command" process listing.
// Only processes started under the terminal's own program count, never that program itself, and
// the one nearest to it names the job; a wait loop names it only when nothing else does.
/** @param {string} listing @param {Map<string, number>} roots @returns {Map<string, string>} */
function backgroundWork(listing, roots) {
  /** @type {Map<number, number[]>} */
  const children = new Map();
  /** @type {Map<number, string>} */
  const commands = new Map();
  for (const line of listing.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]), parent = Number(m[2]);
    commands.set(pid, m[3]);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)?.push(pid);
  }
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [address, root] of roots) {
    const seen = new Set([root]), queue = [...(children.get(root) ?? [])];
    let wait = null, label = null;
    while (queue.length && !label) {
      const pid = Number(queue.shift());
      if (seen.has(pid)) continue;
      seen.add(pid);
      const found = workLabel(commands.get(pid) ?? "");
      if (found === WAIT_LOOP) wait ??= found; else label = found;
      queue.push(...(children.get(pid) ?? []));
    }
    if (label ?? wait) out.set(address, String(label ?? wait));
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

// Firstmate's state detail is " · "-separated machine text, such as
// "validating (running) · run: 01M6ZA…". Cards show a short reading of the shapes it is known
// to take; anything else keeps Firstmate's own text. Run ids and the PR link are dropped: the
// card links the PR, from detailPr when nothing else names it. The worker's last status text
// shows only when nothing is left.
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const RUN_IDS = new RegExp(`;?\\s*(?:last reported )?run ids?:[\\s,]*(?:${ULID.source}[\\s,]*)*`, "g");
function readableDetail(task) {
  const raw = task?.current_state?.detail;
  if (!raw) return "";
  const parts = raw.split(" · ").map((p) => p.trim())
    .filter((p) => p && !/^(?:earlier )?run: /.test(p) && !/^pr=/.test(p));
  const head = parts[0] ?? "";
  let m;
  if ((m = /^(?:validating|run active) \((.+)\)$/.exec(head))) return `Validating: ${m[1]}`;
  if ((m = /^parked at ([^:]+?)(?::\s*(\d+) finding\(s\))?$/.exec(head))) {
    if (parts.includes("ask-user: authority decision")) return `Waiting for a firstmate decision at ${m[1]}`;
    return `Stopped at ${m[1]}${m[2] ? ` · ${m[2]} finding${m[2] === "1" ? "" : "s"}` : ""}`;
  }
  if ((m = /^checks green: (PR [a-z ]+?)\s*(?:\(|:|$)/.exec(head))) return `Checks passed · ${m[1]}`;
  if ((m = /^run passed: (PR [a-z ]+?)\s*(?:\(|:|$)/.exec(head))) {
    return `Validation passed · ${m[1]}${/verification skipped\)$/.test(head) ? " · CI verification skipped" : ""}`;
  }
  const known = { "ci running": "CI running", "run active": "Validating", "run completed": "Validation completed", "run failed": "Validation failed" };
  if (known[head]) return known[head];
  const rest = parts.map((p) => p.replace(RUN_IDS, "; ").replace(ULID, "").replace(/^[;\s]+|[;\s]+$/g, "")
    .replace(/\s{2,}/g, " ")).filter(Boolean).join(" · ");
  return rest || lastEventDetail(task);
}

// The PR URL in Firstmate's detail, which it adds when the worker never reported one.
function detailPr(detail) {
  const parts = (detail ?? "").split(" · ").map((p) => p.trim());
  return parts.find((p) => p.startsWith("pr="))?.slice(3) || /https:\/\/\S+?\/pull\/\d+/.exec(detail ?? "")?.[0] || null;
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

// The start of a Board answer draft. An open decision's key rides along as "[key=<key>]", which
// firstmate passes to fm-send --resolve-key to close exactly that decision.
/** @param {string[]} ids @param {string} [key] */
function answerHead(ids, key = "") {
  return `[Board answer] ${ids.join(", ")}${key ? ` [key=${key}]` : ""}:`;
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
// full note or detail even where the card truncates or hides it, its decision's question and
// options, and every open decision's text).
function searchText(c) {
  const decision = c.decision ? [c.decision.question, ...c.decision.options.map((o) => o.text)] : [];
  const open = c.openDecisions.map((d) => d.summary);
  return [c.id, c.title, c.detail, c.sourceDetail, ...decision, ...open].filter(Boolean).join("\n").toLowerCase();
}

function cardsFrom(snapshot) {
  const tasks = new Map((snapshot.tasks ?? []).map((t) => [t.id, t]));
  const records = (snapshot.backlog?.records ?? []).filter((r) => r.structured);
  const pairs = records.map((r) => ({ record: r, task: tasks.get(r.id) }));
  const known = new Set(records.map((r) => r.id));
  const titles = new Map(records.map((r) => [r.id, r.title ?? r.id]));
  for (const t of snapshot.tasks ?? []) if (!known.has(t.id)) pairs.push({ record: null, task: t });
  return pairs.map(({ record, task }) => {
    // Every decision the worker's status log still holds open, in the snapshot's order: newest last.
    const openDecisions = (task?.hints?.open_decisions ?? []).map((d) => {
      const summary = String(d?.summary ?? "");
      return { key: String(d?.key ?? ""), verb: String(d?.verb ?? ""), summary, decision: parseDecision(summary) };
    });
    const decisionText = record?.hold_reason || openDecisions[0]?.summary || "";
    const decision = parseDecision(decisionText);
    // A hold's question is the card's detail. An open decision is listed in full below the
    // detail instead, so a detail that only repeats one is left out.
    const detail = (record?.hold_reason ? decision?.question : "") || (inferred(task, record) ? lastEventDetail(task) : "")
      || readableDetail(task) || record?.hold_reason || "";
    const listed = openDecisions.some((d) => d.summary && (detail.includes(d.summary) || detail === d.decision?.question));
    return {
    id: record?.id ?? task.id,
    decision,
    // True when the decision above is the backlog hold's own, which the card draws as before.
    heldDecision: Boolean(record?.hold_reason),
    openDecisions,
    // Which HOLD_GROUPS entry a Held card is drawn under, and the date a deferred one waits for.
    holdGroup: HOLD_GROUP_OF[record?.hold_bucket] ?? "now",
    holdUntil: typeof record?.hold_until === "string" ? record.hold_until : null,
    column: columnOf(record, task),
    // What columnOf says; column moves away from it only while the worker runs a background job.
    ownColumn: columnOf(record, task),
    title: record?.title ?? task.id,
    // Unfinished work this item waits on, by title; empty when it can start.
    waitingOn: (record?.unresolved_blocker_ids ?? []).map((id) => titles.get(id) ?? id),
    waitingIds: record?.unresolved_blocker_ids ?? [],
    // Backlog priority 0 (highest) to 4; null when the item has none.
    priority: /^[0-4]$/.test(String(record?.priority ?? "")) ? Number(record.priority) : null,
    project: projectOf(task?.project, record?.repo),
    // An unobservable worker shows the state its column was derived from, not "unknown".
    state: inferred(task, record) ? columnOf(record, task) : task?.current_state?.state ?? record?.state ?? "",
    detail: listed ? "" : detail,
    // Firstmate's own wording, kept so the search still finds it.
    sourceDetail: task?.current_state?.detail ?? "",
    pr: task?.pr?.url ?? record?.pr_url ?? detailPr(task?.current_state?.detail),
    prWaiting: prWaiting(record, task),
    // Only hc runs workers in Herdr terminals, so only those can be opened from here.
    terminal: task?.backend === "hc" ? hcAddress(task) : null,
    // The worker's isolated copy, for the read-only Files/Changes view.
    worktree: task?.paths?.worktree?.present ? task.paths.worktree.path : null,
    };
  });
}

export default class FmBoard extends View {
  /** @param {number} px */
  fs(px) { return Math.round(px * this.fontScale * 2) / 2; }

  readFontScale(width) {
    let terminal = DESIGN_FONT_PX;
    try { terminal = Number(settings()?.font_size) || DESIGN_FONT_PX; } catch {}
    const narrow = terminal / DESIGN_FONT_PX, wide = terminal / LARGEST_TEXT_PX;
    const w = Number.isFinite(width) ? width : 0;
    const k = Math.min(1, Math.max(0, (w - STACK_BELOW_PX) / (GROW_FULL_PX - STACK_BELOW_PX)));
    this.fontScale = narrow + (wide - narrow) * k;
  }

  init(_props, cx) {
    this.fontScale = 1;
    const ui = props()?.ui ?? {};
    this.cards = null; this.projects = []; this.requests = []; this.ready = null;
    this.error = null; this.notice = ""; this.generated = ""; this.loading = false; this.last = 0;
    this.size = null; this.collapsed = new Set(props()?.collapsed ?? this.loadSet(COLLAPSED_KEY));
    this.folded = new Set(ui.folded ?? this.loadSet(FOLDED_KEY));
    this.open = new Set(ui.open ?? []); this.filter = ui.filter ?? null;
    this.chainOpen = new Set(ui.chains ?? []);
    this.pasting = false;
    // Worker screen tails by terminal address. Display only: never logged or written anywhere.
    /** @type {Map<string, string[]>} */
    this.tails = new Map();
    /** @type {Set<string>} */
    this.shownTerminals = new Set();
    // Why a shown worker's last read gave no lines, by terminal address, for the lines' tooltip.
    /** @type {Map<string, string>} */
    this.tailNotes = new Map();
    /** @type {{ started: number } | null} */
    this.tailRound = null;
    // Start times of the reads that have not ended, by terminal address, so hung reads cannot pile up.
    /** @type {Map<string, number[]>} */
    this.tailReading = new Map();
    // The job each live worker's terminal runs, by terminal address, from the last process listing.
    /** @type {Map<string, string>} */
    this.background = new Map();
    /** @type {{ started: number } | null} */
    this.backgroundRound = null;
    // Start times of the listings that have not ended, so hung listings cannot pile up.
    /** @type {number[]} */
    this.backgroundListing = [];
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
    cx.timer.every(TAIL_REFRESH_MS, (cx) => this.readTails(cx));
    cx.timer.every(BACKGROUND_REFRESH_MS, (cx) => this.readBackground(cx));
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
      .child(div().flex_none().text_size(this.fs(11)).text_color(t.dim).child("Color"))
      .children(PROJECT_COLORS.map((c) => swatch(`color-${name}-${c}`, c, c, (cx) => this.pickColor(name, c, cx))))
      .child(div().id(`color-${name}-auto`).flex_none().px(6).py(1).rounded(9).border(1)
        .border_color(this.colorChoice[name] ? t.border : t.foreground).text_size(this.fs(11)).text_color(t.muted)
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
      .child(div().flex_none().text_size(this.fs(10)).text_color(t.dim).child(folded ? "▸" : "▾"))
      .child(div().flex_1().min_w(0).when(folded, (e) => e.truncate()).text_size(this.fs(12)).font_semibold().text_color(t.foreground).child(label));
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
      const address = hcAddress(task);
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
    return div().id(id).px(6).py(2).rounded(5).cursor_pointer().text_size(this.fs(11))
      .text_color(strong ? t.solid_foreground : t.muted).bg(strong ? t.solid : t.raised)
      .hover((s) => s.opacity(0.8)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  field(state, t) {
    return Input.new(state).h(28).px(8).rounded(6).border_1().border_color(t.input)
      .bg(t.background).text_size(this.fs(12)).text_color(t.foreground);
  }

  addForm(t) {
    return v_flex().gap(6).p(8).rounded(6).bg(t.background)
      .child(h_flex().gap(4).items_center()
        .child(div().flex_1().min_w(0).child(this.field(this.source, t)))
        .child(this.button("add-pick", "Choose folder", t, (cx) => this.pick(cx))))
      .child(this.field(this.name, t))
      .when(Boolean(this.picked), (el) => el.child(div().text_size(this.fs(11)).text_color(t.dim).child(
        this.picked.remote ? `${this.picked.folder} · clones from remote`
          : `${this.picked.folder} · no remote, clones from this folder`)))
      .child(h_flex().gap(4).flex_wrap().children(MODES.map((m) =>
        div().id(`mode-${m.id}`).px(6).py(2).rounded(5).cursor_pointer().text_size(this.fs(11))
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
        .child(div().text_size(this.fs(10)).text_color(t.dim).child(open ? "▾" : "▸"))
        .child(this.projectBadge(p.name, t, `ptag-${p.name}`))
        .child(div().flex_1().min_w(0).truncate().text_size(this.fs(12)).text_color(t.foreground).child(p.name))
        .child(div().flex_none().text_size(this.fs(11)).text_color(t.dim)
          .child(counts || "No tasks"))
        .child(this.viewButton(p.name, t)));
    if (!open) return row;
    row.child(div().text_size(this.fs(11)).text_color(t.muted).child(p.desc))
      .child(div().text_size(this.fs(11)).text_color(t.dim)
        .child(`${modeLabel(p.mode)} · Auto-merge ${p.yolo ? "on" : "off"}`))
      .child(this.colorPicker(p.name, t));
    if (this.confirm === p.name) {
      return row.child(div().text_size(this.fs(11)).text_color(t.foreground)
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
    return h_flex().gap(6).child(div().flex_1().min_w(0).text_size(this.fs(11)).text_color(t.muted).truncate().child(body))
      .child(div().flex_none().text_size(this.fs(11)).text_color(t.dim).child("Pending"));
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
        .child(div().text_size(this.fs(10)).text_color(t.dim).child(collapsed ? "▸" : "▾"))
        .child(div().text_size(this.fs(12)).font_semibold().text_color(t.foreground).child("Projects"))
        .child(div().text_size(this.fs(11)).text_color(t.dim).child(String(this.projects.length))))
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
  // When its terminal cannot be proven, a submitted request becomes a Board request for the next drain.
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
      if (!terminal && insertOnly) { this.notice = "Could not find the firstmate terminal"; cx.notify(); return; }
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
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.notice = insertOnly ? message : `Could not type into firstmate: ${message}`;
      }
      cx.notify();
    });
  }

  // Paste has a different lifecycle from hc send: focus, insert without Enter,
  // then restore clipboard text after Herdr has had time to consume it.
  // Only text survives pbpaste, so a clipboard holding images, files, or no text is left alone.
  // The saved text stays in a temp file: argv cannot carry large text or NUL bytes.
  // Clipboard tools otherwise fall back to a legacy encoding in GUI environments.
  /** @param {string} terminal @param {string} line @param {import("gpui-kit").AsyncContext} cx */
  async pasteToFirstmate(terminal, line, cx) {
    if (this.pasting) throw new Error("A card is already being inserted; try again");
    this.pasting = true;
    let saved = null;
    /** @param {string} script @param {string[]} args */
    const clip = (script, ...args) => exec("/usr/bin/env", ["LC_ALL=en_US.UTF-8", "sh", "-c", script, "board-clipboard", ...args]);
    try {
      const info = await exec("/usr/bin/env", ["LC_ALL=en_US.UTF-8", "osascript", "-e", "clipboard info"]);
      if (info.code !== 0) throw new Error("Could not read the clipboard types");
      const types = info.stdout.trim().split(", ").filter((x, i) => x && i % 2 === 0);
      if (types.some((x) => IMAGE_OR_FILE_CLIPBOARD_TYPE.test(x))) {
        throw new Error("Clipboard holds an image or file, so nothing was inserted. Paste it first, then click again.");
      }
      run("agent.focus", { terminal });
      await new Promise((resolve) => cx.timer.after(100, () => resolve(null)));
      if (focused()?.terminal !== terminal) throw new Error("Could not focus the firstmate terminal");
      const previous = await clip("f=$(mktemp -t fm-board-clipboard) || exit 1; pbpaste > \"$f\" || { rm -f \"$f\"; exit 1; }; "
        + "if [ \"$1\" = filled ] && [ ! -s \"$f\" ]; then rm -f \"$f\"; exit 3; fi; printf '%s' \"$f\"", types.length ? "filled" : "empty");
      if (previous.code === 3) throw new Error("Clipboard holds no plain text, so nothing was inserted. Paste it first, then click again.");
      if (previous.code !== 0 || !previous.stdout) throw new Error("Could not save clipboard text");
      saved = previous.stdout;
      const copied = await clip("printf '%s' \"$1\" | pbcopy", line);
      if (copied.code !== 0) throw new Error("Could not copy the card text");
      // Focus may have changed while the clipboard command was running.
      if (focused()?.terminal !== terminal) throw new Error("Firstmate terminal focus changed; try again");
      run("terminal.paste");
      await new Promise((resolve) => cx.timer.after(300, () => resolve(null)));
    } finally {
      try {
        if (saved !== null) {
          const restored = await clip("pbcopy < \"$1\"; s=$?; rm -f \"$1\"; exit $s", saved);
          if (restored.code !== 0) throw new Error("Could not restore clipboard text");
        }
      } finally { this.pasting = false; }
    }
  }

  /** @param {string} text @param {import("gpui-kit").Context} cx */
  insertCardText(text, cx) {
    this.typeToFirstmate(text, "", "Text is in the firstmate input, waiting for Enter", cx, undefined, true);
  }

  /** @param {string} key @param {string[]} ids @param {string} title @param {Record<string, `#${string}`>} t */
  askButton(key, ids, title, t) {
    const cleanTitle = title.replace(/`/g, "'");
    return div().id(`ask-card-${key}`).flex_none().p(3).rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip("Ask firstmate about this task")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.insertCardText(`\`[Board card] ${ids.join(", ")}: ${cleanTitle}\``, cx);
      })
      .child(div().w(this.fs(14)).h(this.fs(14)).rounded(this.fs(7)).border(1).border_color(t.muted)
        .flex().items_center().justify_center().text_size(this.fs(11)).text_color(t.muted).child("?"));
  }

  // A small icon-only card control in the Ask icon's style; the label is its tooltip and what a
  // screen reader announces.
  /** @param {string} id @param {string} icon @param {string} label @param {Record<string, `#${string}`>} t @param {(cx: import("gpui-kit").Context) => void} onClick */
  iconButton(id, icon, label, t, onClick) {
    return div().id(id).flex_none().p(3).rounded(5).cursor_pointer().role("button").accessibility_label(label)
      .hover((s) => s.bg(t.hover)).tooltip(label)
      .on_click((_e, cx) => onClick(cx))
      .child(svg(icon).size(this.fs(14)).text_color(t.muted));
  }

  openWorkerIcon(c, t) {
    return this.iconButton(`open-${c.id}`, "mods/workspace-chrome/terminal.svg", "Open worker", t, (cx) => this.openWorker(c, cx));
  }

  typeCommand(command, cx) {
    this.typeToFirstmate(command, `[Board request] Run ${command}`, `Typed ${command} into firstmate`, cx);
  }

  commandSection(t) {
    const collapsed = this.collapsed.has(COMMANDS);
    const el = this.frame(v_flex().flex_none().gap(8), t)
      .child(h_flex().id("head-commands").gap(6).items_center().px(6).py(4).rounded(5).bg(t.selected)
        .cursor_pointer().hover((s) => s.opacity(0.75)).on_click((_e, cx) => this.toggle(COMMANDS, cx))
        .child(div().text_size(this.fs(10)).text_color(t.dim).child(collapsed ? "▸" : "▾"))
        .child(div().text_size(this.fs(12)).font_semibold().text_color(t.foreground).child("Commands")));
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
        .child(div().flex_none().text_size(this.fs(11)).text_color(t.dim).child(this.askProject ? "Project" : "Project (optional)"))
        .children(this.projects.map((p) => chip(p.name))));
  }

  card(c, t, inGroup) {
    // A search shows matching cards open, without changing the remembered folds.
    const foldId = `card:${c.id}`, folded = this.folded.has(foldId) && !this.query;
    const current = this.query && this.currentMatch === c.id;
    // A queued card that still waits on other work is dimmed and says what it waits on.
    const waiting = c.column === "queued" && c.waitingOn.length > 0;
    // A held card in the "Waiting on other work" group says what it waits on the same way.
    const waitsOn = waiting || (c.column === "held" && c.holdGroup === "waiting" && c.waitingOn.length > 0);
    const until = c.column === "held" && c.holdGroup === "deferred" && c.holdUntil ? c.holdUntil : null;
    const badge = c.prWaiting ? div().flex_none().text_size(this.fs(11)).font_semibold().text_color(t.blocked).child("PR waiting") : null;
    const el = v_flex().id(`card-${c.id}`).gap(4).p(8).rounded(6).bg(t.background)
      .border(current ? 2 : 1).border_color(current ? t.accent : t.border).when(waiting && !current, (e) => e.opacity(0.6))
      .child(this.foldRow(foldId, t, folded, c.title, badge)
        .child(this.askButton(foldId, [c.id], c.title, t)));
    if (folded) return el;
    // The project sits on the state row so the title keeps the full card width.
    el.child(h_flex().gap(6).items_center().min_w(0)
      .child(this.projectBadge(c.project || "firstmate", t, `tag-${c.id}`))
      .when(c.priority !== null && c.column !== "done", (e) => e.child(div().flex_none().px(4).rounded(4).border(1)
        .border_color(c.priority === 0 ? t.foreground : t.border).text_size(this.fs(10))
        .text_color(c.priority === 0 ? t.foreground : t.muted).tooltip("Backlog priority, 0 is highest").child(`P${c.priority}`)))
      .child(div().flex_1().min_w(0).text_size(this.fs(11)).text_color(t.muted).truncate()
        .tooltip("Task state from firstmate").child(waiting ? "waiting" : c.state))
      // The year is left out: a deferral date is always ahead, and "until 12-01" fits a narrow card.
      .when(Boolean(until), (e) => e.child(div().id(`until-${c.id}`).flex_none().text_size(this.fs(11)).font_semibold()
        .text_color(t.muted).tooltip(`Deferred until ${until}`).child(`until ${String(until).replace(/^\d{4}-/, "")}`))));
    if (waitsOn) {
      const key = `chain:${c.id}`, shown = this.chainOpen.has(key);
      el.child(div().id(`wait-${c.id}`).min_w(0).text_size(this.fs(11)).text_color(t.blocked).truncate()
        .cursor_pointer().hover((st) => st.opacity(0.75))
        .tooltip(shown ? "Hide the order" : "Show the order this task waits on")
        .on_click((_e, cx) => { if (!this.chainOpen.delete(key)) this.chainOpen.add(key); cx.notify(); })
        .child(`${shown ? "▾" : "▸"} ${waitingLabel(c)}`));
      if (shown) el.child(this.chain(c, t));
    }
    // The same tint as the Live strip: the working color alone is too faint as text on a light theme.
    if (c.background) el.child(h_flex().id(`background-${c.id}`).gap(6).px(6).py(2).rounded(5).items_center().min_w(0)
      .bg(t.working + "1f").tooltip("Its agent's turn has ended, but the worker's terminal is still running this")
      .child(div().flex_none().w(6).h(6).rounded(3).bg(t.working))
      // In a narrow column the job's name moves to a second line whole, instead of being cut off.
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap_x(4).text_size(this.fs(11)).font_semibold().text_color(t.foreground)
        .child(div().flex_none().child("백그라운드 실행 중:")).child(div().min_w(0).truncate().child(c.background))));
    if (c.detail && !inGroup) el.child(div().text_size(this.fs(11)).text_color(t.dim).child(c.detail.slice(0, 140)));
    const ownDecision = c.heldDecision && c.decision && !c.decision.topic;
    if (ownDecision) this.decisionLines(el, c.decision, t, `card:${c.id}`, [c.id], c.column === "held");
    c.openDecisions.forEach((d, i) => this.openDecision(el, c, d, i, t));
    if (c.pr && /^https:\/\//.test(c.pr)) {
      el.child(div().id(`pr-${c.id}`).text_size(this.fs(11)).text_color(t.accent).truncate()
        .hover((s) => s.text_color(t.foreground))
        .on_click(() => { exec("open", [c.pr]); })
        .child(c.pr.replace("https://github.com/", "")));
    }
    const live = c.column !== "done";
    const workerLive = this.workerLive(c);
    // A live worker's Open worker icon moves into its live strip, beside Peek.
    const openHere = live && c.terminal && !workerLive;
    if (openHere || (live && c.worktree && c.project)) {
      const row = h_flex().gap(4).items_center();
      if (openHere) row.child(this.openWorkerIcon(c, t));
      if (c.worktree && c.project) row.child(this.button(`files-${c.id}`, "Files · Changes", t, (cx) =>
        this.openView(c.project, { path: c.worktree, label: c.id, title: `${c.project} · ${c.id}` }, cx)));
      el.child(row);
    }
    if (workerLive) {
      this.shownTerminals.add(c.terminal);
      el.child(this.liveStrip(c, t));
    }
    return el;
  }

  // A live worker's own region below the card body, so the body keeps the shape of cards in
  // other columns. It always holds TAIL_LINES rows, blank until lines arrive, so the card does
  // not change height as the worker's screen changes. Its background is a light tint of the
  // working color, because surface and raised sit too close to the card background to set it apart.
  liveStrip(c, t) {
    const lines = this.tails.get(c.terminal) ?? [];
    const blank = String.fromCharCode(0xa0); // a no-break space keeps an empty row one line tall
    const rows = Array.from({ length: TAIL_LINES }, (_, i) => lines[i] || blank);
    return v_flex().id(`live-${c.id}`).gap(4).px(6).py(4).rounded(5).bg(t.working + "1f")
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().w(6).h(6).rounded(3).bg(t.working))
        .child(div().flex_1().min_w(0).text_size(this.fs(10)).font_semibold().text_color(t.muted)
          .tooltip("The worker terminal's own status; the card's state above is the task's").child(this.workerStatusLabel(c)))
        .child(this.openWorkerIcon(c, t))
        // Herdr's own peek: the worker's terminal opens over the current tab, and nothing else changes.
        .child(this.iconButton(`peek-${c.id}`, "mods/workspace-chrome/layers.svg", "Peek at the worker's terminal over this tab", t,
          () => { run("terminal.peek", { terminal: c.terminal }); })))
      .child(v_flex().id(`tail-${c.id}`).gap(1).font_family(this.monoFont).tooltip(this.tailTooltip(c.terminal))
        // Muted rather than dim: dim text loses too much contrast on the tinted background.
        .children(rows.map((line) => div().min_w(0).truncate().text_size(this.fs(10.5)).text_color(t.muted).child(line))));
  }

  // Says why the lines are empty when this terminal's last read failed or has not ended.
  tailTooltip(address) {
    const note = this.tailNotes.get(address);
    return note ? `Last lines of the worker's screen. ${note.slice(0, 200)}` : "Last lines of the worker's screen";
  }

  // Options of a held decision become editable chat drafts; the owner confirms them with Enter.
  // Elsewhere they are plain text: set-aside work in Todo waits until it is brought back.
  // An open decision's options carry its key in the draft, so firstmate can close that decision.
  /** @param {string[]} ids @param {boolean} answerable @param {string} [decisionKey] */
  decisionLines(el, decision, t, key, ids, answerable, decisionKey = "") {
    for (const o of decision.options) {
      el.child(h_flex().id(`opt-${key}-${o.label}`).gap(6).px(4).py(2).rounded(5)
        .when(answerable, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Put this answer in the firstmate input")
          .on_click((_e, cx) => this.insertCardText(`${answerHead(ids, decisionKey)} ${o.label} (${o.text})`, cx)))
        .child(div().flex_none().text_size(this.fs(11)).font_semibold().text_color(t.accent).child(o.label))
        .child(div().flex_1().min_w(0).text_size(this.fs(11)).text_color(t.foreground).child(o.text)));
    }
    if (decision.recommended) el.child(div().text_size(this.fs(11)).text_color(t.muted).child(`Recommended: ${decision.recommended}`));
    return el;
  }

  // One decision the worker's status log still holds open: its verb and key, its text, and its
  // options when the text has them. Clicking the text starts an answer draft that names the
  // decision's key; an option fills the answer in. The owner confirms either with Enter.
  openDecision(el, c, d, i, t) {
    const id = `open-${c.id}-${i}`;
    el.child(v_flex().id(id).gap(1).px(4).py(2).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip("Start an answer to this decision in the firstmate input")
      .on_click((_e, cx) => this.insertCardText(answerHead([c.id], d.key), cx))
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().flex_none().text_size(this.fs(10)).font_semibold().text_color(t.blocked).child(d.verb))
        .child(div().flex_1().min_w(0).truncate().text_size(this.fs(10)).text_color(t.dim).child(d.key)))
      .child(div().text_size(this.fs(11)).text_color(t.foreground).child((d.decision?.question || d.summary).slice(0, 240))));
    if (d.decision) this.decisionLines(el, d.decision, t, id, [c.id], true, d.key);
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
      .child(svg("mods/files/folder.svg").size(this.fs(14)).text_color(shown ? t.foreground : t.muted));
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

  // A card's worker terminal is live and still carries this task's label (hc can reuse an address).
  workerLive(c) {
    if (!c.terminal || c.column === "done") return false;
    return this.liveWorkers?.get(c.terminal)?.task === `fm-${c.id}`;
  }

  // The worker terminal's own status, which Herdr reports, as opposed to the card's task state:
  // a task can still be validating while its worker has ended its turn and sits idle.
  // Herdr's "done" (finished while nobody looked) is idle too once seen, so both read as idle.
  workerStatusLabel(c) {
    const status = this.liveWorkers?.get(c.terminal)?.status;
    if (status === "working" || status === "blocked") return `Worker ${status}`;
    if (status === "idle" || status === "done") return "Worker idle";
    return "Live";
  }

  // What the worker's terminal still runs after its agent's turn ended, or null. A working
  // agent runs its commands as part of its turn, which the card already shows.
  /** @returns {string | null} */
  backgroundOf(c) {
    if (!this.workerLive(c) || this.liveWorkers?.get(c.terminal)?.status === "working") return null;
    return this.background.get(c.terminal) ?? null;
  }

  // One process listing for every card with a live worker; a tick is skipped while a round is
  // still running. A card is shown as running only on a listing that just succeeded: a failed
  // listing, one not ended after BACKGROUND_ROUND_LIMIT_MS, or one held back because
  // BACKGROUND_OPEN_LISTINGS earlier listings are still running, clears every card's job. A round
  // past the limit is dropped with its late result, so a hung listing cannot stop later rounds.
  readBackground(cx) {
    const now = Date.now();
    if (this.backgroundRound && now - this.backgroundRound.started < BACKGROUND_ROUND_LIMIT_MS) return;
    if (this.backgroundRound) this.setBackground(new Map(), cx);
    this.backgroundRound = null;
    /** @type {Map<string, number>} */
    const roots = new Map();
    for (const c of this.cards ?? []) {
      const pid = this.workerLive(c) ? this.liveWorkers?.get(c.terminal)?.pid : null;
      if (Number.isSafeInteger(pid) && pid > 1) roots.set(c.terminal, pid);
    }
    this.backgroundListing = this.backgroundListing.filter((t) => now - t < BACKGROUND_STALE_LISTING_MS);
    if (!roots.size || this.backgroundListing.length >= BACKGROUND_OPEN_LISTINGS) { this.setBackground(new Map(), cx); return; }
    const round = this.backgroundRound = { started: now };
    this.backgroundListing.push(now);
    cx.spawn(async (cx) => {
      /** @type {Map<string, string>} */
      let next = new Map();
      try {
        // By absolute path, so the listing does not depend on the PATH the app was started with.
        const r = await exec("/bin/ps", ["-axww", "-o", "pid=,ppid=,command="], { timeout: PROCESS_LIST_TIMEOUT_MS });
        if (r.code === 0) next = backgroundWork(r.stdout, roots);
      } catch {} // a failed or stopped listing leaves every card as it is without a job
      this.backgroundListing = this.backgroundListing.filter((t) => t !== now);
      if (this.backgroundRound !== round) return;
      this.backgroundRound = null;
      this.setBackground(next, cx);
    });
  }

  /** @param {Map<string, string>} next @param {import("gpui-kit").Context | import("gpui-kit").AsyncContext} cx */
  setBackground(next, cx) {
    const changed = next.size !== this.background.size || [...next].some(([address, label]) => this.background.get(address) !== label);
    this.background = next;
    if (changed) cx.notify();
  }

  // One read per worker whose card is on screen; a tick is skipped while a round is still
  // running, and a failed read shows nothing for that card, with the reason in its tooltip.
  // A read still running belongs to a dropped round, so it is at least TAIL_ROUND_LIMIT_MS old;
  // its terminal is read once more, with at most TAIL_READS_PER_TERMINAL reads younger than
  // TAIL_STALE_READ_MS running for it.
  // exec settles only once the program's output closes, so a process left holding it keeps a
  // round open past the read timeout. Such a round stops holding back new rounds after
  // TAIL_ROUND_LIMIT_MS and its late result is dropped; otherwise the lines would stop for good.
  readTails(cx) {
    const addresses = [...this.shownTerminals];
    if (this.tailRound && Date.now() - this.tailRound.started < TAIL_ROUND_LIMIT_MS) return;
    this.tailRound = null;
    if (!addresses.length) { this.tails.clear(); this.tailNotes.clear(); return; }
    const round = this.tailRound = { started: Date.now() };
    cx.spawn(async (cx) => {
      /** @type {Map<string, string[]>} */
      const next = new Map();
      /** @type {Map<string, string>} */
      const notes = new Map();
      await Promise.all(addresses.map(async (address) => {
        const reading = this.tailReading.get(address) ?? [];
        const { started } = round;
        if (reading.filter((t) => started - t < TAIL_STALE_READ_MS).length >= TAIL_READS_PER_TERMINAL) {
          notes.set(address, `An earlier read has not ended after ${Math.round((started - reading[0]) / 1000)} s.`);
          return;
        }
        reading.push(started);
        this.tailReading.set(address, reading);
        try {
          const r = await exec("hc", ["read", address], { timeout: TAIL_READ_TIMEOUT_MS });
          if (r.code === 0) next.set(address, screenTail(r.stdout));
          else notes.set(address, `The last read failed: ${r.stderr.trim() || `hc read exited ${r.code}`}`);
        } catch (e) { notes.set(address, `The last read failed: ${String(e?.message ?? e)}`); }
        finally {
          reading.splice(reading.indexOf(started), 1);
          if (!reading.length) this.tailReading.delete(address);
        }
      }));
      if (this.tailRound !== round) return;
      this.tailRound = null;
      const changed = next.size !== this.tails.size
        || [...next].some(([address, lines]) => this.tails.get(address)?.join("\n") !== lines.join("\n"))
        || [...notes].some(([address, note]) => this.tailNotes.get(address) !== note) || notes.size !== this.tailNotes.size;
      this.tails = next;
      this.tailNotes = notes;
      if (changed) cx.notify();
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
        .child(div().flex_1().min_w(0).text_size(this.fs(11)).truncate()
          .text_color(self ? t.foreground : t.dim).when(self, (e) => e.font_semibold())
          .child(strip(x?.title ?? id)))
        .child(div().flex_none().text_size(this.fs(10)).text_color(color).child(label));
    };
    const arrow = () => div().pl(1).text_size(this.fs(11)).text_color(t.muted).child("↓");
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
        div().flex_none().text_size(this.fs(11)).text_color(t.dim).child(String(cards.length)))
        .child(this.askButton(foldId, ids, question, t)));
    if (folded) return box;
    this.decisionLines(box, first.decision, t, `group:${topic}`, ids, cards.some((c) => c.column === "held"));
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

  // A column's cards in drawing order, split into its labelled groups: the Held column has
  // HOLD_GROUPS (only those holding a card), every other column one unlabelled group.
  sections(id) {
    const cards = this.cardsIn(id);
    if (id !== "held") return [{ id, title: null, cards }];
    return HOLD_GROUPS.map((g) => ({ ...g, cards: cards.filter((c) => c.holdGroup === g.id) })).filter((s) => s.cards.length);
  }

  // Matching card ids in the order the board draws them: columns left to right, then down each column.
  matchIds() {
    return this.shownColumns().flatMap((col) => this.sections(col.id)).flatMap((s) => this.entries(s.cards))
      .flatMap((x) => (x.topic ? x.cards : [x.card])).map((c) => c.id);
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
        .child(svg("mods/workspace-chrome/search.svg").size(this.fs(14)).text_color(t.muted)))
      .when(count !== null, (el) =>
        el.child(div().flex_none().text_size(this.fs(11)).text_color(matches.length ? t.muted : t.blocked).child(count)));
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
      .child(div().text_size(this.fs(10)).text_color(t.dim).child(collapsed ? "▸" : "▾"))
      .child(div().w(8).h(8).rounded(4).bg(t[col.color]));
    if (collapsed && !stacked) {
      return v_flex().id(`col-${col.id}`).w(36).h_full().p(8).gap(6).rounded(8).bg(t.surface).items_center()
        .child(header)
        .child(div().text_size(this.fs(11)).text_color(t.dim).child(String(cards.length)))
        .child(v_flex().items_center().children([...col.title].map((letter) =>
          div().text_size(this.fs(11)).font_semibold().text_color(t.foreground).child(letter))));
    }
    header.px(6).py(4).rounded(5).bg(t.selected)
      .child(div().text_size(this.fs(12)).font_semibold().text_color(t.foreground).child(col.title))
      .child(div().text_size(this.fs(11)).text_color(t.dim).child(String(cards.length)));
    const el = v_flex().id(`col-${col.id}`).min_w(0).gap(8).p(8).rounded(8).bg(t.surface).child(header);
    if (!stacked) el.flex_1().h_full();
    else el.flex_none(); // stacked columns keep their height; the board scrolls as one list
    if (collapsed) return el;
    const list = v_flex().id(`list-${col.id}`).gap(6);
    for (const s of this.sections(col.id)) {
      if (!s.title) { list.children(this.items(s.cards, t)); continue; }
      // Each group is its own element, so a topic box drawn in two groups keeps a distinct id.
      list.child(v_flex().id(`hold-${s.id}`).gap(6)
        .child(h_flex().gap(6).items_center().px(2).pt(2)
          .child(div().text_size(this.fs(11)).font_semibold().text_color(s.id === "now" ? t.foreground : t.muted).child(s.title))
          .child(div().text_size(this.fs(11)).text_color(t.dim).child(String(s.cards.length))))
        .children(this.items(s.cards, t)));
    }
    return el.child(stacked ? list : list.flex_1().min_h(0).overflow_y_scrollbar());
  }

  // The same tag on project rows and cards; hovering shows the full project name.
  projectBadge(name, t, id) {
    const color = this.colorOf(name, t);
    const tag = this.tags?.get(name) ?? name.slice(0, 3).toUpperCase();
    // A fixed width (scaled with the text) keeps every tag the same size, whatever its letters.
    return h_flex().id(id).flex_none().w(this.fs(38)).justify_center().py(1).rounded(9).bg(color)
      .text_size(this.fs(11)).font_semibold().text_color("#ffffff").tooltip(name).child(tag);
  }

  badge(label, color) {
    return div().flex_none().px(6).py(1).rounded(5).border(1).border_color(color).text_size(this.fs(11)).text_color(color).child(label);
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
        .child(div().text_size(this.fs(11)).text_color(w.up ? t.dim : t.ansi1).child(label));
    });
  }

  footer(t) {
    const text = (value) => div().min_w(0).text_size(this.fs(11)).text_color(t.dim).truncate().child(value);
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
    this.readFontScale(this.size?.width);
    const names = [...this.projects.map((p) => p.name), ...(this.cards ?? []).map((c) => c.project).filter(Boolean)];
    this.tags = abbreviations(["firstmate", ...names]);
    this.autoColor = autoColors(names);
    const t = theme();
    if (!home()) return v_flex().id("home-required").size_full().bg(t.canvas).p(16)
      .child(v_flex().gap(8).p(16).rounded(8).bg(t.surface).border(1).border_color(t.border)
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child("Firstmate home required"))
        .child(div().text_size(13).text_color(t.muted).child("Set the home prop on this mod in your layout to the path of your firstmate home.")));
    // terminals() is live data, so a worker starting or ending redraws the cards.
    this.liveWorkers = new Map(terminals().filter((x) => x.state === "live")
      .map((x) => [x.address, { task: x.labels?.["firstmate.task"], status: x.status, pid: x.pid }]));
    // A paused card whose worker still runs a job is drawn in Working until that job ends.
    for (const c of this.cards ?? []) {
      c.background = this.backgroundOf(c);
      c.column = c.background && c.ownColumn === "paused" ? "working" : c.ownColumn;
    }
    this.monoFont = String(settings()?.font_family ?? "JetBrains Mono");
    // The cards drawn below record which worker screens are worth reading.
    this.shownTerminals = new Set();
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
        .child(div().text_size(this.fs(11)).text_color(t.muted).child(`Filter: ${this.filter}`))
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
          .child(this.viewer.render(t, (px) => this.fs(px), this.viewSources(this.viewProject)))));
  }

  // The starting width only: after the first drag Herdr keeps the user's width under
  // the group id. Half the Board when its width is known, else a readable default.
  viewerWidth() {
    const w = this.size?.width;
    return w ? Math.max(420, Math.round(w / 2)) : 560;
  }
}
