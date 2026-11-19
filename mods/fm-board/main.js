// Firstmate board: the day's counts and the next call on top, tasks in the middle, and
// commands, projects, and checks in a tab group below. Fleet data comes from
// fm-fleet-snapshot.sh; this mod never changes it. Adding or removing a project
// only sends a note through fm-inbox.sh, and firstmate does the work under its
// project-management procedure. The Command buttons type their slash command
// into the open firstmate terminal through hc.
// props: { home, snapshot_file?, collapsed?, ui? }. home is the firstmate
// installation and operational home; the other props support preview fixtures.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, h_resizable, resizable_panel, ScrollHandle } from "gpui-base";
import { exec, pickFolder, props, readTextFile, watchFolder, theme, settings, run, focused, terminals, checking, appHome, layout, setShared, nextCommand } from "herdr";
import { FolderViewer } from "./viewer.js";

// Board text follows the terminal font size and grows as the Board widens. The sizes below
// were drawn for Herdr's default 14px terminal font. At the stacking width they keep that
// proportion to the terminal font; by GROW_FULL_PX the largest Board text (12px titles)
// reaches the terminal font size, which is the ceiling.
const DESIGN_FONT_PX = 14;
const LARGEST_TEXT_PX = 12;
const GROW_FULL_PX = 1600;
const REFRESH_FALLBACK_MS = 30000;
const REFRESH_TIMEOUT_MS = 15000;
const FM_EXEC_TIMEOUT_MS = 10000;
const CORE_STATUS_TIMEOUT_MS = 3000;
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
// The Ledger theme's mono face, shared with the PR viewer mod (theme-spec Ledger section): numbers,
// task ids, timers, and tags. It ships with Herdr. Worker screen lines keep the terminal font.
const DATA_FONT = "Geist Mono";
// The Ledger theme's shapes: the colored bar on a card's left edge, and the opacity of
// everything that does not need the captain while Focus is on.
const CARD_BAR_PX = 3;
const FOCUS_DIM = 0.22;
// How long the ring on a card the NEXT MOVE card line pointed to stays.
const POINT_RING_MS = 4000;
// The separate PR viewer mod a PR link opens when it is installed. Its panel contract: the layout's
// `pr` block in the panel-body stack shows it, and the shared value below asks it for one PR.
const PR_VIEWER_MOD = "herdr-pr-viewer";
const PR_PANEL = "pr";
const PR_SHOW_KEY = "herdr-pr-viewer.show";
const STACK_BELOW_PX = 720; // narrower than this, columns stack as an accordion
// The most of the Board's height the compact inspector's chain takes before it scrolls.
const COMPACT_INSPECTOR_SHARE = 0.35;
const NO_CHAINS_TEXT = "No active task dependencies in the current backlog snapshot.";
const COLLAPSED_KEY = "collapsed";
const FOLDED_KEY = "folded";
const VIEW_MODE_KEY = "viewMode";
const INDEPENDENT_OPEN_KEY = "independentOpen";
// The tab group below the board: its folded state (in the collapsed set) and its chosen tab.
const BOTTOM = "bottom";
const BOTTOM_TAB_KEY = "bottomTab";
const BOTTOM_TABS = ["commands", "projects", "checks"];
// Reads only the list of state/*.check.sh filenames and the mtime of state/.last-check.
// Never reads check scripts, check outputs, or private check state directories.
const CHECKS_SCRIPT = [
  'state="$1"',
  // An existing state folder that cannot be listed is a failed read, not a home with no checks.
  'if [ -d "$state" ] && ! { [ -r "$state" ] && [ -x "$state" ]; }; then exit 1; fi',
  'last=""',
  'if [ -e "$state/.last-check" ]; then',
  '  last=$(stat -f %m "$state/.last-check" 2>/dev/null || stat -c %Y "$state/.last-check" 2>/dev/null || true)',
  "fi",
  "printf 'last\\0%s\\0' \"$last\"",
  'for p in "$state"/*.check.sh; do',
  '  [ -f "$p" ] || continue',
  '  name=${p##*/}',
  '  name=${name%.check.sh}',
  "  printf 'check\\0%s\\0' \"$name\"",
  "done",
].join("\n");
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
  // Parked waits on review activity, not on the captain: its own color keeps it apart from Held
  // (the captain's call), Blocked, Working, and Review.
  { id: "parked", title: "Parked", color: "ansi5", optional: true },
  { id: "blocked", title: "Blocked", color: "blocked", optional: true },
  { id: "paused", title: "Paused", color: "idle", optional: true },
  { id: "review", title: "Review", color: "done", optional: true },
  { id: "unknown", title: "Unknown", color: "unknown", optional: true },
  { id: "done", title: "Done", color: "done" },
];
const MODES = [
  { id: "no-mistakes-prod-only", label: "Validate product changes" },
  { id: "no-mistakes", label: "Always validate" },
  { id: "direct-PR", label: "Direct PR" },
  { id: "local-only", label: "Local only" },
];
const modeLabel = (id) => MODES.find((m) => m.id === id)?.label ?? id;
// The Held column's groups, in drawing order.
const HOLD_GROUPS = [
  { id: "now", title: "Answer now" },
  { id: "deferred", title: "Deferred" },
  { id: "waiting", title: "Waiting on other work" },
];
// The group a hold belongs to, following the snapshot's hold_bucket: only a "live" hold is the
// captain's current call. "dated" (until hold_until) and "aged" holds are deferred, and "blocked"
// waits on unfinished work. Only captain holds have a bucket: an "external" hold waits on
// something outside, and a captain hold with no bucket is one to answer now.
function holdGroupOf(record) {
  const bucket = record?.hold_bucket;
  if (bucket === "dated" || bucket === "aged") return "deferred";
  if (bucket === "blocked" || record?.hold_kind === "external") return "waiting";
  return "now";
}
const home = () => typeof props()?.home === "string" ? props().home.trim().replace(/(.)\/+$/, "$1") : "";
// Fixed to Korea time, which has no daylight saving.
function koreaTime(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 19);
}
// Formats Unix epoch seconds in the viewer's local time (MM-DD HH:MM:SS on another day).
function localTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return "";
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const day = d.toDateString() === new Date().toDateString() ? "" : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} `;
  return `${day}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
// The layout node with this id, searching the whole tree (the shape fm-tabs reads too).
function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}
// The Korea-time date (YYYY-MM-DD) of a moment, the calendar the backlog's done dates use.
/** @param {number} ms */
function koreaDate(ms) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
// How long a hold has waited, from the backlog's hold-set stamp (a UTC time, or only a date) or,
// for an unstamped hold, its filing date: "2h 14m" from a time, "today" or "3d" from a date.
/** @param {string | null} stamp @param {number} now */
function waitAge(stamp, now) {
  if (typeof stamp !== "string") return "";
  const ms = Date.parse(stamp);
  if (Number.isNaN(ms)) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(stamp)) {
    const days = Math.round((Date.parse(koreaDate(now)) - ms) / 86400000);
    return days <= 0 ? "today" : `${days}d`;
  }
  const minutes = Math.max(0, Math.floor((now - ms) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
// The captain's own calls: a hold to answer now, or a worker that reported failed.
const needsCaptain = (c) => (c.column === "held" && c.holdGroup === "now") || c.failed;
// The decision a topic's cards share: the first of them that lists options, else the first.
const sharedDecision = (cards) => (cards.find((c) => c.decision?.options.length) ?? cards[0])?.decision;
const base = (path) => (path ?? "").split("/").filter(Boolean).pop() ?? "";
// The backlog writes "-" for an item with no project; such items are firstmate's own work.
const projectOf = (...paths) => paths.map(base).find((p) => p && p !== "-") ?? "";
// A project keeps one color on every card, so the eye can group cards without reading.
// Mid-tone hues that all carry white text. A project gets the first hue no other project holds
// when it is first seen and keeps it, so adding or removing other projects never changes it; the
// hue is freed once the project has left both the registry and the cards. Projects get distinct
// colors while free hues remain. With none free, a project takes a color from its name and keeps
// it even after a hue is freed; a color picked on the project row wins but leaves the project's
// automatic hue reserved for Auto. In those cases two projects can share a color.
const PROJECT_COLORS = [
  "#2f7fc1", "#2e9d5b", "#c0563a", "#8a4fbf", "#b8860b", "#16958f", "#c23d7a",
  "#4f5fc7", "#6b8e23", "#a0522d", "#0f7ea8", "#9c3fa3", "#58708a", "#b03a3a",
];
const PROJECT_COLORS_KEY = "projectColors";
const AUTO_COLORS_KEY = "autoProjectColors";
// Once every hue is held, or the store is unusable: FNV-1a over the name's UTF-16 units, spread over the palette.
function autoColor(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return PROJECT_COLORS[(h >>> 0) % PROJECT_COLORS.length];
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

function parseHexRgb(hex) {
  const m = /^#([0-9a-f]{6})/i.exec(hex ?? "");
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
}

function formatHexRgb(rgb) {
  return "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

// Badge text is white, so a light theme color (bright yellow or cyan) is darkened until white stays legible.
function readableOnWhite(hex) {
  const rgb = parseHexRgb(hex);
  if (!rgb) return hex;
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  const k = Math.min(1, 0.5 / Math.max(lum, 0.01));
  return formatHexRgb(rgb.map((c) => c * k));
}

// Midpoint of two #rrggbb theme colors in sRGB.
function mixColor(a, b) {
  const ra = parseHexRgb(a), rb = parseHexRgb(b);
  if (!ra || !rb) return a;
  return formatHexRgb(ra.map((c, i) => (c + rb[i]) / 2));
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
  const text = task?.hints?.last_event_text ?? "";
  const m = /^[a-z-]+\s*(?:\[[^\]]*\]\s*)*(?::\s*(.*))?$/s.exec(text);
  return m ? (m[1] ?? "") : text;
}

// Firstmate's state detail is " · "-separated machine text, such as
// "validating (running) · run: 01M6ZA…". Cards show a short reading of the shapes it is known
// to take; anything else keeps Firstmate's own text. Run ids and the PR link are dropped: the
// card links the PR, from detailPr when nothing else names it. The worker's last status text
// shows only when nothing is left.
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const RUN_IDS = new RegExp(`;?\\s*(?:last reported )?run ids?:[\\s,]*(?:${ULID.source}[\\s,]*)*`, "g");
const RUN_REF = new RegExp(`\\b(?:earlier\\s+)?run:\\s*${ULID.source}`, "g");
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

// Strips machine noise from a paused reason, turns "until <UTC>" into local "until HH:MM" (with
// "MM-DD" before it on another day), and shortens a PR link to "owner/repo#N".
/** @param {string} text @returns {string} */
function cleanPausedReason(text) {
  if (!text) return "";
  let out = text
    .replace(/\[(?:at|key)=[^\]]*\]/g, "")
    .replace(/\b(?:at|key|pr)=\S+/g, "")
    .replace(RUN_IDS, "; ")
    .replace(RUN_REF, "")
    .replace(ULID, "")
    .replace(/(?:[;,]\s*)?\bdetails=\S+/g, "")
    .replace(/\buntil\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z)\b/gi, (m, iso) => {
      const ms = Date.parse(iso);
      if (Number.isNaN(ms)) return m;
      const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
      const day = d.toDateString() === new Date().toDateString() ? "" : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} `;
      return `until ${day}${pad(d.getHours())}:${pad(d.getMinutes())}`;
    })
    .replace(/https:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/g, "$1#$2");
  out = out
    .replace(/\s*;\s*(?:;\s*)+/g, "; ")
    .replace(/\s*,\s*(?:,\s*)+/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[;,\s·]+|[;,\s·]+$/g, "");
  return out;
}

const WAITING_CLAUSE = /\b(?:awaiting|waiting\s+for|waits\s+on|until\s+(?:\d{2}-\d{2}\s+)?\d{2}:\d{2}|resume\s+(?:when|on|at|once)|retry)\b|대기|기다|재개/i;

// Rotates the text at the separator before the first waiting/until/resume clause so single-line truncation keeps what is waited on visible.
/** @param {string} text @returns {string} */
function prioritizeWaitingClause(text) {
  if (!text) return "";
  const match = WAITING_CLAUSE.exec(text);
  if (!match) return text;
  const head = text.slice(0, match.index);
  const separator = /^until\b/i.test(match[0]) && /,\s*$/.test(head) ? /\s*;\s*/g : /\s*(?:;\s*|,\s+)/g;
  const boundary = [...head.matchAll(separator)].at(-1);
  if (!boundary) return text;
  return `${text.slice(boundary.index + boundary[0].length)}; ${text.slice(0, boundary.index)}`;
}

// The PR URL in Firstmate's detail, which it adds when the worker never reported one.
function detailPr(detail) {
  const parts = (detail ?? "").split(" · ").map((p) => p.trim());
  return parts.find((p) => p.startsWith("pr="))?.slice(3) || /https:\/\/\S+?\/pull\/\d+/.exec(detail ?? "")?.[0] || null;
}

function columnOf(record, task) {
  const state = task?.current_state?.state;
  // No Failed column: Firstmate reports a failure in chat and acts on it, so a failed card waits in Blocked, marked "Failed".
  if (state === "failed") return "blocked";
  if (state === "done" || record?.state === "done") return "done";
  if (task?.hints?.pending_decision) return "parked";
  if (task?.hints?.blocked_event) return "blocked";
  // Firstmate cannot observe Codex, but hc can: trust only an explicit working report.
  if (state === "unknown" && task?.core_status === "working") return "working";
  // Codex on hc never reports its own state; fall back to the worker's last status event.
  if (state === "unknown") {
    const last = /^([a-z-]+)/.exec(task?.hints?.last_event_text ?? "")?.[1];
    if (last === "done") return task?.pr?.url || branchReady(record, task) ? "review" : "paused";
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

// A local-only ship whose worker reported done (either as current state or as its last
// status event when the harness is unobservable) waits on local landing approval until its
// backlog item is marked done or merged. Scouts never have a branch to land.
function branchReady(record, task) {
  if (task?.mode !== "local-only" || (task?.kind && task.kind !== "ship")) return false;
  if (record?.state === "done" || record?.merged) return false;
  if (task?.pr?.url) return false;
  const state = task?.current_state?.state;
  if (state === "done") return true;
  if (state === "unknown") return /^([a-z-]+)/.exec(task?.hints?.last_event_text ?? "")?.[1] === "done";
  return false;
}

// "<lead> <title>", or "<lead> 2 · <first title>"; the card's own project name is
// dropped from the front of the title because the card already shows it. The dependency
// badge leads with "← Waits on".
function waitingLabel(c, lead = "Waiting on") {
  const strip = (title) => (c.project && title.startsWith(`${c.project} `) ? title.slice(c.project.length + 1) : title);
  const n = c.waitingOn.length;
  return `${lead} ${n > 1 ? `${n} · ` : ""}${strip(c.waitingOn[0])}`;
}

// "★ Blocks N →" on a card that other tasks wait on.
function blocksLabel(c) {
  return `★ Blocks ${c.blocksCount} →`;
}

// Derives reverse dependencies (blockingIds, transitive downstream blocks, and count),
// topological levels with a cycle guard, and connected chain components across all cards.
function dependencyGraph(cards) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const c of cards ?? []) {
    if (!c?.id) continue;
    const waitingIds = [...new Set((c.waitingIds ?? []).filter((id) => id && id !== c.id))];
    byId.set(c.id, Object.assign(c, { waitingIds }));
  }
  for (const c of [...byId.values()]) {
    for (const u of c.waitingIds) {
      if (!byId.has(u)) {
        byId.set(u, { id: u, title: u, project: "", waitingIds: [], missing: true });
      }
    }
  }
  /** @type {Map<string, string[]>} */
  const blockingMap = new Map([...byId.keys()].map((id) => [id, []]));
  for (const c of byId.values()) {
    for (const u of c.waitingIds) {
      const list = blockingMap.get(u);
      if (list && !list.includes(c.id)) list.push(c.id);
    }
  }
  for (const [id, c] of byId) {
    c.waitingOn = (c.waitingIds ?? []).map((u) => byId.get(u)?.title ?? u);
    c.blockingIds = blockingMap.get(id) ?? [];
  }
  for (const [id, c] of byId) {
    /** @type {string[]} */
    const up = [];
    const seenUp = new Set([id]);
    const queueUp = [...c.waitingIds];
    while (queueUp.length) {
      const cur = queueUp.shift();
      if (!cur || seenUp.has(cur)) continue;
      seenUp.add(cur);
      up.push(cur);
      queueUp.push(...(byId.get(cur)?.waitingIds ?? []));
    }
    /** @type {string[]} */
    const down = [];
    const seenDown = new Set([id]);
    const queueDown = [...c.blockingIds];
    while (queueDown.length) {
      const cur = queueDown.shift();
      if (!cur || seenDown.has(cur)) continue;
      seenDown.add(cur);
      down.push(cur);
      queueDown.push(...(byId.get(cur)?.blockingIds ?? []));
    }
    c.upstreamIds = up;
    c.blocks = down;
    c.blocksOn = down.map((d) => byId.get(d)?.title ?? d);
    c.blocksCount = down.length;
    c.crossProjectBlockers = c.waitingIds.filter((u) => {
      const upProj = byId.get(u)?.project;
      return Boolean(c.project && upProj && c.project !== upProj);
    });
  }
  /** @type {Map<string, number>} */
  const levels = new Map();
  /** @type {Set<string>} */
  const cycleNodes = new Set();
  /** @param {string} id @param {Set<string>} [visiting] @returns {number} */
  const computeLevel = (id, visiting = new Set()) => {
    if (levels.has(id)) return levels.get(id) ?? 0;
    visiting.add(id);
    const ups = byId.get(id)?.waitingIds ?? [];
    let maxUp = -1;
    for (const u of ups) {
      if (visiting.has(u)) {
        cycleNodes.add(id);
        cycleNodes.add(u);
        continue;
      }
      maxUp = Math.max(maxUp, computeLevel(u, visiting));
    }
    visiting.delete(id);
    const d = maxUp >= 0 ? 1 + maxUp : 0;
    levels.set(id, d);
    return d;
  };
  for (const id of byId.keys()) computeLevel(id);
  /** @type {Set<string>} */
  const visitedComp = new Set();
  /** @type {any[]} */
  const rawComponents = [];
  const orderIndex = new Map([...byId.keys()].map((id, i) => [id, i]));
  for (const [id, c] of byId) {
    if (visitedComp.has(id) || (!c.waitingIds.length && !c.blockingIds.length)) continue;
    /** @type {string[]} */
    const memberIds = [];
    const queue = [id];
    visitedComp.add(id);
    while (queue.length) {
      const cur = queue.shift();
      if (!cur) continue;
      memberIds.push(cur);
      const node = byId.get(cur);
      for (const next of [...(node?.waitingIds ?? []), ...(node?.blockingIds ?? [])]) {
        if (!visitedComp.has(next) && byId.has(next)) {
          visitedComp.add(next);
          queue.push(next);
        }
      }
    }
    memberIds.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
    const minLevel = Math.min(...memberIds.map((m) => levels.get(m) ?? 0));
    /** @type {Map<number, string[]>} */
    const byLevel = new Map();
    for (const m of memberIds) {
      const lv = (levels.get(m) ?? 0) - minLevel;
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv)?.push(m);
    }
    const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
    const levelGroups = sortedLevels.map((lv) => {
      const ids = byLevel.get(lv) ?? [];
      const nodes = ids.map((m) => byId.get(m)).filter(Boolean);
      const crossProjectEdges = [];
      const joinNodes = [];
      for (const n of nodes) {
        for (const u of n.waitingIds ?? []) {
          const upNode = byId.get(u);
          if (n.project && upNode?.project && n.project !== upNode.project) {
            crossProjectEdges.push({ from: u, to: n.id, fromProject: upNode.project, toProject: n.project });
          }
        }
        if ((n.waitingIds ?? []).length > 1) {
          joinNodes.push({ id: n.id, blockers: n.waitingIds });
        }
      }
      return {
        level: lv,
        ids,
        nodes,
        hasCrossProject: crossProjectEdges.length > 0,
        hasJoin: joinNodes.length > 0,
        hasBranch: ids.length > 1,
        crossProjectEdges,
        joinNodes,
      };
    });
    const roots = levelGroups[0]?.ids ?? [memberIds[0]];
    const crossProjectEdges = levelGroups.flatMap((g) => g.crossProjectEdges);
    const joins = levelGroups.flatMap((g) => g.joinNodes);
    const hasCycle = memberIds.some((m) => cycleNodes.has(m));
    const maxBlocks = Math.max(0, ...memberIds.map((m) => byId.get(m)?.blocksCount ?? 0));
    rawComponents.push({
      roots,
      depth: levelGroups.length,
      maxBlocks,
      nodeIds: memberIds,
      levels: levelGroups,
      crossProjectEdges,
      joins,
      hasCycle,
    });
  }
  rawComponents.sort((a, b) => b.nodeIds.length - a.nodeIds.length || b.depth - a.depth);
  /** @type {Map<string, any>} */
  const componentById = new Map();
  const components = rawComponents.map((comp, idx) => {
    const id = `chain-${idx + 1}`;
    const rootId = comp.roots[0] ?? comp.nodeIds[0] ?? id;
    const leafId = comp.levels.at(-1)?.ids[0] ?? comp.nodeIds.at(-1) ?? rootId;
    const summaryLabel = rootId !== leafId ? `${rootId} → ${leafId}` : rootId;
    const enriched = { id, summaryLabel, ...comp };
    for (const m of comp.nodeIds) componentById.set(m, enriched);
    return enriched;
  });
  return { nodes: byId, components, componentById };
}

// Computes card highlight roles ("upstream", "selected", "downstream", "branch") for the active
// focus card and dims unrelated cards only while a chain is selected.
function chainHighlight(graph, selectedCardId = null, hoveredCardId = null) {
  const focusId = hoveredCardId ?? selectedCardId;
  const selectedComp = selectedCardId ? graph?.componentById?.get(selectedCardId) ?? null : null;
  const focusNode = focusId ? graph?.nodes?.get(focusId) ?? null : null;
  const focusComp = focusId ? graph?.componentById?.get(focusId) ?? null : null;
  /** @type {Map<string, "upstream" | "selected" | "downstream" | "branch">} */
  const roles = new Map();
  if (focusNode && focusComp) {
    roles.set(focusId, "selected");
    for (const u of focusNode.upstreamIds ?? []) if (!roles.has(u)) roles.set(u, "upstream");
    for (const d of focusNode.blocks ?? []) if (!roles.has(d)) roles.set(d, "downstream");
    for (const m of focusComp.nodeIds ?? []) if (!roles.has(m)) roles.set(m, "branch");
  }
  /** @type {Set<string>} */
  const dimmedIds = new Set();
  if (selectedComp) {
    const inComp = new Set(selectedComp.nodeIds);
    for (const id of graph?.nodes?.keys() ?? []) {
      if (!inComp.has(id)) dimmedIds.add(id);
    }
  }
  return {
    selectedComponent: selectedComp,
    focusComponent: focusComp,
    roles,
    dimmedIds,
  };
}

// Tie-breaker for selecting the longest forward dependency spine inside a component.
function compareChainBranch(aId, aLen, bId, bLen, nodesMap, order, levelOf) {
  if (aLen !== bLen) return bLen - aLen;
  if (levelOf) {
    const levelDiff = (levelOf.get(aId) ?? 0) - (levelOf.get(bId) ?? 0);
    if (levelDiff !== 0) return levelDiff;
  }
  const blockDiff = (nodesMap.get(bId)?.blocksCount ?? 0) - (nodesMap.get(aId)?.blocksCount ?? 0);
  if (blockDiff !== 0) return blockDiff;
  const prioDiff = (nodesMap.get(aId)?.priority ?? Infinity) - (nodesMap.get(bId)?.priority ?? Infinity);
  if (prioDiff !== 0) return prioDiff;
  return (order.get(aId) ?? 0) - (order.get(bId) ?? 0);
}

// Splits a connected component into its longest forward path (main spine) and the per-level
// steps, spine node first, in the order both Chains layouts draw them. Follows strictly increasing levels so cycles never loop.
function chainSpineLayout(comp, nodesMap) {
  const levelOf = new Map();
  for (const lg of comp?.levels ?? []) {
    for (const id of lg.ids) levelOf.set(id, lg.level);
  }
  const order = new Map((comp?.nodeIds ?? []).map((id, i) => [id, i]));
  /** @type {Map<string, { len: number, next: string | null }>} */
  const memo = new Map();
  const bestFrom = (id) => {
    const hit = memo.get(id);
    if (hit) return hit;
    const lv = levelOf.get(id) ?? 0;
    const node = nodesMap.get(id);
    let bestNext = null;
    let bestSub = 0;
    for (const succId of node?.blockingIds ?? []) {
      if (!levelOf.has(succId) || (levelOf.get(succId) ?? 0) <= lv) continue;
      const sub = bestFrom(succId).len;
      if (!bestNext || compareChainBranch(succId, sub, bestNext, bestSub, nodesMap, order) < 0) {
        bestNext = succId;
        bestSub = sub;
      }
    }
    const res = { len: 1 + bestSub, next: bestNext };
    memo.set(id, res);
    return res;
  };
  let startId = comp?.nodeIds?.[0] ?? null;
  let startLen = -1;
  for (const id of comp?.nodeIds ?? []) {
    const len = bestFrom(id).len;
    if (startLen < 0 || compareChainBranch(id, len, startId, startLen, nodesMap, order, levelOf) < 0) {
      startId = id;
      startLen = len;
    }
  }
  const spineIds = [];
  const spineSet = new Set();
  for (let cur = startId; cur && !spineSet.has(cur); cur = bestFrom(cur).next) {
    spineSet.add(cur);
    spineIds.push(cur);
  }
  const steps = (comp?.levels ?? []).map((lg) => ({
    level: lg.level,
    nodes: [...lg.nodes].sort((a, b) => Number(spineSet.has(b.id)) - Number(spineSet.has(a.id))),
  }));
  return {
    spine: spineIds.map((id) => nodesMap.get(id)).filter(Boolean),
    steps,
  };
}

const CHAIN_CARD_W = 200;
const CHAIN_GUT = 72;
const CHAIN_GUT_STUB = 21;
const CHAIN_PORT_TOP = 14;
const CHAIN_PORT_STEP = 24;
const CHAIN_R = 6;
const CHAIN_ROW_PAD = 24;
const CHAIN_LANE_GAP = 10;
const CHAIN_HEAD_W = 6;
const CHAIN_HEAD_H = 9;

// Single source of truth for horizontal-line and arrowhead vertical alignment:
// a 1px top border occupies [y, y+1] (center y+0.5), so an odd-height head places
// its tip row directly on the line.
function chainJoint(y) {
  return {
    lineTop: y,
    lineH: 1,
    headTop: y - (CHAIN_HEAD_H - 1) / 2,
    headW: CHAIN_HEAD_W,
    headH: CHAIN_HEAD_H,
  };
}

function chainShortId(id) {
  return String(id ?? "").replace(/^[a-z]+-/, "");
}

function chainRoleColor(role, t) {
  if (role === "selected") return t.accent;
  if (role === "upstream") return t.working;
  if (role === "downstream") return t.ansi6;
  return null;
}

function chainEdgeColor(e, roles, t) {
  if (!roles || !roles.size) return { c: t.dim, o: 1 };
  const ru = roles.get(e.u), rv = roles.get(e.v);
  if (ru === "upstream" && (rv === "upstream" || rv === "selected")) return { c: t.working, o: 1 };
  if ((ru === "selected" || ru === "downstream") && rv === "downstream") return { c: t.ansi6, o: 1 };
  return { c: t.dim, o: 0.4 };
}

// Places a component onto a level grid (spine on row 0, side branches on rows >= 1) and routes
// every edge. An edge whose straight path along its source row would run through a card detours
// through a lane in the row padding instead: below the source row, or above it when the target
// sits higher. Ports are ordered above < same row < below, and the vertical turns sharing a
// gutter are ordered by where they lead, so no two lines share a stretch of track.
/** @param {any} comp */
const chainLaneKey = (comp) => `lane:${comp.roots?.[0] ?? comp.id}`;

function placeChainLane(comp, nodesMap) {
  const levelOf = new Map();
  for (const lg of comp?.levels ?? []) {
    for (const id of lg.ids) levelOf.set(id, lg.level);
  }
  const ids = comp?.nodeIds ?? [];
  if (!ids.length) return { grid: [], pos: new Map(), edges: [], cols: 0, spineIds: [], levelOf, steps: [], rowPad: [], rowMinH: [], gutterW: [] };
  const minLv = Math.min(...ids.map((id) => levelOf.get(id) ?? 0));
  const maxLv = Math.max(...ids.map((id) => levelOf.get(id) ?? 0));
  const cols = maxLv - minLv + 1;
  const pos = new Map();
  const grid = [];
  const put = (id, r) => {
    const c = (levelOf.get(id) ?? 0) - minLv;
    while (grid.length <= r) grid.push(Array(cols).fill(null));
    grid[r][c] = id;
    pos.set(id, { r, c });
  };
  const { spine, steps } = chainSpineLayout(comp, nodesMap);
  const spineIds = spine.map((n) => n.id);
  for (const id of spineIds) put(id, 0);
  const rest = ids
    .filter((id) => !pos.has(id))
    .sort((a, b) => (levelOf.get(a) ?? 0) - (levelOf.get(b) ?? 0));
  for (const id of rest) {
    const n = nodesMap.get(id);
    const c = (levelOf.get(id) ?? 0) - minLv;
    const upRow = (n?.waitingIds ?? []).map((u) => pos.get(u)?.r).find((r) => r > 0 && !grid[r]?.[c]);
    let r = upRow ?? 1;
    while (grid[r]?.[c]) r++;
    put(id, r);
  }
  const edges = [];
  for (const id of ids) {
    const n = nodesMap.get(id);
    for (const u of n?.waitingIds ?? []) {
      if (!pos.has(u)) continue;
      const U = pos.get(u), V = pos.get(id);
      if (U.c >= V.c) continue;
      const up = nodesMap.get(u);
      const cross = Boolean(n?.project && up?.project && n.project !== up.project);
      const blocked = grid[U.r].slice(U.c + 1, V.c).some(Boolean);
      edges.push({
        u, v: id, cross, p1: CHAIN_PORT_TOP, p2: CHAIN_PORT_TOP, x: null, x0: null,
        chanRow: blocked ? (V.r < U.r ? U.r - 1 : U.r) : null, chan: null,
      });
    }
  }
  const span = (e) => pos.get(e.v).c - pos.get(e.u).c;
  // Wider detours take lower lanes so narrower ones nest inside them; equal spans take lanes in
  // the reverse of their port order, which keeps their turns out of each other's way.
  const lanes = new Map();
  for (const e of [...edges].reverse().sort((a, b) => span(b) - span(a))) {
    if (e.chanRow === null) continue;
    const from = pos.get(e.u).c, to = pos.get(e.v).c - 1;
    if (!lanes.has(e.chanRow)) lanes.set(e.chanRow, []);
    const rowLanes = lanes.get(e.chanRow);
    let i = rowLanes.findIndex((used) => used.every(([a, b]) => to < a || from > b));
    if (i < 0) i = rowLanes.push([]) - 1;
    rowLanes[i].push([from, to]);
    e.chan = Math.floor(CHAIN_ROW_PAD / 2) + CHAIN_LANE_GAP * i;
  }
  const rowPad = grid.map((_, r) => {
    const n = lanes.get(r)?.length ?? 0;
    return r < grid.length - 1 || n ? CHAIN_ROW_PAD + CHAIN_LANE_GAP * Math.max(0, n - 1) : 0;
  });
  const outs = new Map(), ins = new Map();
  for (const e of edges) {
    if (!outs.has(e.u)) outs.set(e.u, []);
    outs.get(e.u).push(e);
    if (!ins.has(e.v)) ins.set(e.v, []);
    ins.get(e.v).push(e);
  }
  // Where an edge heads from its card, in rows: negative above, 0 straight across, positive below.
  // A detour lane sits half a row from the card, between its own row and the next one.
  const outSide = (e) => (e.chanRow === null ? pos.get(e.v).r - pos.get(e.u).r : e.chanRow - pos.get(e.u).r + 0.5);
  const inSide = (e) => (e.chanRow === null ? pos.get(e.u).r - pos.get(e.v).r : e.chanRow - pos.get(e.v).r + 0.5);
  const order = (side) => (a, b) => side(a) - side(b)
    || (a.chanRow === null && side(a) > 0 ? span(b) - span(a) : span(a) - span(b));
  for (const list of outs.values()) list.sort(order(outSide));
  for (const list of ins.values()) list.sort(order(inSide));
  // Port slot j holds an in-port at its top and an out-port half a slot lower, so a line turning
  // out of a card never shares a height with another line turning into the card beside it. An
  // edge straight across its row uses its target's in-port at both ends, placed below every
  // out-port its source lists before it. Every port keeps the full CHAIN_PORT_STEP, and rows grow
  // via rowMinH whenever a card needs more height for its ports.
  const straight = (e) => e.chanRow === null && pos.get(e.u).r === pos.get(e.v).r;
  const inSlot = new Map(), outSlot = new Map(), minSlot = new Map();
  for (const list of outs.values()) list.forEach((e, i) => { if (straight(e)) minSlot.set(e, i); });
  for (const list of ins.values()) {
    let next = 0;
    for (const e of list) {
      const j = Math.max(next, minSlot.get(e) ?? 0);
      inSlot.set(e, j);
      next = j + 1;
    }
  }
  for (const list of outs.values()) {
    let next = 0;
    for (const e of list) {
      if (straight(e)) next = Math.max(next, inSlot.get(e));
      else outSlot.set(e, next++);
    }
  }
  const outSlotOffset = Math.floor(CHAIN_PORT_STEP / 2);
  for (const e of edges) {
    e.p2 = CHAIN_PORT_TOP + CHAIN_PORT_STEP * inSlot.get(e);
    e.p1 = straight(e) ? e.p2 : CHAIN_PORT_TOP + CHAIN_PORT_STEP * outSlot.get(e) + outSlotOffset;
  }
  const rowMinH = grid.map((row) => {
    let maxPort = -Infinity;
    for (const id of row) {
      if (!id) continue;
      for (const e of ins.get(id) ?? []) maxPort = Math.max(maxPort, e.p2);
      for (const e of outs.get(id) ?? []) maxPort = Math.max(maxPort, e.p1);
    }
    return maxPort > -Infinity ? maxPort + CHAIN_PORT_TOP : 0;
  });
  // Vertical positions comparable across rows; a detour lane lies below every port of its row.
  const yAt = (r, y) => r * 10000 + y;
  const turns = new Map();
  const addTurn = (g, from, to, set) => {
    if (!turns.has(g)) turns.set(g, []);
    turns.get(g).push({ key: from < to ? [0, -to] : [1, to], set });
  };
  for (const e of edges) {
    const U = pos.get(e.u), V = pos.get(e.v);
    let from = yAt(U.r, e.p1);
    if (e.chanRow !== null) {
      const lane = yAt(e.chanRow, 9000 - e.chan);
      addTurn(U.c, from, lane, (x) => { e.x0 = x; });
      from = lane;
    }
    const to = yAt(V.r, e.p2);
    if (from !== to) addTurn(V.c - 1, from, to, (x) => { e.x = x; });
  }
  const gutterW = Array.from({ length: Math.max(0, cols - 1) }, (_, g) => {
    const k = turns.get(g)?.length ?? 0;
    return Math.max(CHAIN_GUT, 2 * CHAIN_GUT_STUB + CHAIN_HEAD_W + (k - 1) * CHAIN_PORT_STEP);
  });
  for (const [g, list] of turns) {
    const w = gutterW[g];
    list.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]);
    const startX = Math.round((w - CHAIN_HEAD_W - (list.length - 1) * CHAIN_PORT_STEP) / 2);
    list.forEach((tn, i) => tn.set(startX + i * CHAIN_PORT_STEP));
  }
  return { grid, pos, edges, cols, spineIds, levelOf, steps, rowPad, rowMinH, gutterW };
}

// Computes pure geometry descriptors for every connector piece in gutter (r, g). A slot is
// { top } for a card port or { bottom } for a detour lane in the row padding.
function chainGutterSpecs(layout, r, g) {
  const out = [];
  const R = CHAIN_R, C = CHAIN_R + 1, gutW = layout.gutterW[g];
  for (const e of layout.edges) {
    const U = layout.pos.get(e.u), V = layout.pos.get(e.v);
    if (!(g >= U.c && g < V.c)) continue;
    const add = (kind, id, geo) => out.push({ kind, id: `chain-edge-${e.u}-${e.v}-${id}`, top: null, bottom: null, ...geo, dashed: e.cross, edge: e });
    const enter = (left) => {
      const j = chainJoint(e.p2);
      add("hbar", "line", { top: j.lineTop, left, right: j.headW });
      add("head", "head", { top: j.headTop, right: 0, w: j.headW, h: j.headH });
    };
    // Runs in from the gutter's left edge at slot a on row ra, turns at x, and leaves toward the
    // right edge at slot b on row rb through exit(), with an (R + 1) elbow at each bend.
    const turn = (pre, x, ra, a, rb, b, exit) => {
      if (r < Math.min(ra, rb) || r > Math.max(ra, rb)) return;
      const down = rb > ra || (rb === ra && (b.bottom != null || (a.bottom == null && b.top > a.top)));
      const hang = (s) => (s.bottom == null ? { top: s.top } : { bottom: s.bottom - R });
      const sit = (s) => (s.bottom == null ? { top: s.top - R } : { bottom: s.bottom });
      const below = (s) => (s.bottom == null ? { t: s.top + C } : { b: s.bottom - R });
      const above = (s) => (s.bottom == null ? { t: s.top - R } : { b: s.bottom + C });
      const corner = (kind, left, at) => add("corner", `${pre}corner-${kind}`, { cornerKind: kind, left, ...at, w: C, h: C });
      if (r === ra) {
        add("hbar", `${pre}hbar-${r}-${g}`, { ...a, left: 0, right: gutW - x + R });
        corner(down ? "tr" : "br", x - R, down ? hang(a) : sit(a));
      }
      const from = r === ra && down ? below(a) : r === rb && !down ? below(b) : { t: 0 };
      const to = r === rb && down ? above(b) : r === ra && !down ? above(a) : { b: 0 };
      const geo = from.t == null ? { bottom: to.b, h: from.b - to.b }
        : to.t == null ? { top: from.t, bottom: to.b } : { top: from.t, h: to.t - from.t };
      if (geo.h == null || geo.h > 0) add("vbar", `${pre}vbar-${r}`, { left: x, h: null, ...geo });
      if (r === rb) {
        corner(down ? "bl" : "tl", x, down ? sit(b) : hang(b));
        exit();
      }
    };
    const last = g === V.c - 1;
    const port1 = { top: e.p1 }, port2 = { top: e.p2 }, lane = { bottom: e.chan };
    if (e.chanRow === null) {
      if (!last) {
        if (r === U.r) add("hbar", `hbar-${r}-${g}`, { ...port1, left: 0, right: 0 });
      } else if (U.r === V.r && e.p1 === e.p2) {
        if (r === U.r) enter(0);
      } else {
        turn("", e.x, U.r, port1, V.r, port2, () => enter(e.x + C));
      }
    } else if (g === U.c) {
      turn("out-", e.x0, U.r, port1, e.chanRow, lane, () => add("hbar", `chan-${r}-${g}`, { ...lane, left: e.x0 + C, right: 0 }));
    } else if (last) {
      turn("", e.x, e.chanRow, lane, V.r, port2, () => enter(e.x + C));
    } else if (r === e.chanRow) {
      add("hbar", `chan-${r}-${g}`, { ...lane, left: 0, right: 0 });
    }
  }
  return out;
}

// Computes pure geometry descriptors for edge pieces inside grid cell (r, col): straight lines
// passing through an empty cell, and detour lanes running through the row padding below a card.
function chainCellSpecs(layout, r, col) {
  const out = [];
  for (const e of layout.edges) {
    const U = layout.pos.get(e.u), V = layout.pos.get(e.v);
    if (!(col > U.c && col < V.c)) continue;
    const base = { kind: "hbar", top: null, bottom: null, left: 0, right: 0, dashed: e.cross, edge: e };
    if (e.chanRow === null && r === U.r) out.push({ ...base, id: `chain-edge-${e.u}-${e.v}-pass-${r}-${col}`, top: e.p1 });
    if (e.chanRow === r) out.push({ ...base, id: `chain-edge-${e.u}-${e.v}-chan-${r}-${col}`, bottom: e.chan });
  }
  return out;
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
  const cards = pairs.map(({ record, task }) => {
    // Every decision the worker's status log still holds open, in the snapshot's order: newest last.
    const openDecisions = (task?.hints?.open_decisions ?? []).map((d) => {
      const summary = String(d?.summary ?? "");
      return { key: String(d?.key ?? ""), verb: String(d?.verb ?? ""), summary, decision: parseDecision(summary) };
    });
    // Only a backlog hold has a card-level decision; open decisions are listed on their own.
    const decision = parseDecision(record?.hold_reason || "");
    // A hold's question is the card's detail. An open decision is listed in full below the
    // detail instead, so a detail that only repeats one is left out.
    const ownColumn = columnOf(record, task);
    // Only the worker's own "paused" status line says what a paused card waits for.
    const waitingFor = ownColumn === "paused" && !decision?.question
      && /^paused(?:\s|\[|:|$)/.test(task?.hints?.last_event_text ?? "") ? cleanPausedReason(lastEventDetail(task)) : "";
    const detail = waitingFor || decision?.question || (inferred(task, record) ? lastEventDetail(task) : "")
      || readableDetail(task) || record?.hold_reason || "";
    const listed = openDecisions.some((d) => d.summary && (detail.includes(d.summary) || detail === d.decision?.question));
    return {
    id: record?.id ?? task.id,
    decision,
    openDecisions,
    // Which HOLD_GROUPS entry a Held card is drawn under, and the date a deferred one waits for.
    holdGroup: holdGroupOf(record),
    holdUntil: typeof record?.hold_until === "string" ? record.hold_until : null,
    // When the hold was set (a UTC time or a date), else when the item was filed; for wait ages.
    heldSince: record?.hold_set ?? record?.since ?? null,
    // The day a finished item merged, reported, or was done, for the Today strip.
    completedOn: record?.completion?.date ?? null,
    column: ownColumn,
    // The worker reported `failed:`; its card sits in Blocked and carries a red Failed label.
    failed: task?.current_state?.state === "failed",
    // What columnOf says; column moves away from it only while the worker runs a background job.
    ownColumn,
    title: record?.title ?? task.id,
    // Unfinished work this item waits on, by title; empty when it can start.
    waitingOn: (record?.unresolved_blocker_ids ?? []).map((id) => titles.get(id) ?? id),
    waitingIds: record?.unresolved_blocker_ids ?? [],
    // Backlog priority 0 (highest) to 4; null when the item has none.
    priority: /^[0-4]$/.test(String(record?.priority ?? "")) ? Number(record.priority) : null,
    project: projectOf(task?.project, record?.repo),
    // An unobservable worker shows the state its column was derived from, not "unknown".
    state: inferred(task, record) ? ownColumn : task?.current_state?.state ?? record?.state ?? "",
    detail: listed ? "" : detail,
    waitingFor: listed ? "" : waitingFor,
    // Firstmate's own wording, kept so the search still finds it.
    sourceDetail: task?.current_state?.detail ?? "",
    pr: task?.pr?.url ?? record?.pr_url ?? detailPr(task?.current_state?.detail),
    prWaiting: prWaiting(record, task),
    branchReady: branchReady(record, task),
    // Only hc runs workers in Herdr terminals, so only those can be opened from here.
    terminal: task?.backend === "hc" ? hcAddress(task) : null,
    // The worker's isolated copy, for the read-only Files/Changes view.
    worktree: task?.paths?.worktree?.present ? task.paths.worktree.path : null,
    };
  });
  return cards;
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
    // The Board's own place on the keyboard's path, so Escape reaches it after a chain is picked.
    this.keys = cx.focus_handle();
    const ui = props()?.ui ?? {};
    this.cards = null; this.projects = []; this.requests = []; this.ready = null;
    this.checks = null; this.lastCheckSweep = null; this.checksFailed = false;
    this.error = null; this.notice = ""; this.generated = ""; this.loading = false; this.last = 0;
    /** @type {{ timer: import("gpui-kit").Task | null } | null} */
    this.activeRefresh = null;
    this.size = null; this.collapsed = new Set(props()?.collapsed ?? this.loadSet(COLLAPSED_KEY));
    this.folded = new Set(ui.folded ?? this.loadSet(FOLDED_KEY));
    this.open = new Set(ui.open ?? []); this.filter = ui.filter ?? null;
    this.viewMode = ui.viewMode === "chains" || ui.viewMode === "kanban"
      ? ui.viewMode
      : (this.loadText(VIEW_MODE_KEY) === "chains" ? "chains" : "kanban");
    this.independentOpen = typeof ui.independentOpen === "boolean"
      ? ui.independentOpen
      : this.loadText(INDEPENDENT_OPEN_KEY) === "true";
    /** @type {string | null} */
    this.selectedCardId = null;
    /** @type {string | null} */
    this.cursorId = null;
    /** @type {string | null} */
    this.detailCardId = null;
    this.pendingInitialCursor = false;
    /** @type {string | null} */
    this.hoveredCardId = null;
    this.inspectorOpen = false;
    // Focus: everything but the captain's calls dimmed, j/k moving between them.
    this.focusMode = false;
    /** @type {string | null} */
    this.focusId = null;
    // The card a reference such as the NEXT MOVE card line brought into view, ringed until Escape.
    /** @type {string | null} */
    this.pointedId = null;
    this.pointedAt = 0;
    // Folds and collapsed columns an inspector click shows open for now, without saving them.
    /** @type {Set<string>} */
    this.revealed = new Set();
    this.rightSplitWidth = 0;
    this.splitWasOpen = false;
    // One handle per scroll area: the stacked board, each column's card list, and the Chains board.
    this.boardScroll = ScrollHandle.new();
    this.chainsScroll = ScrollHandle.new();
    this.colScrolls = new Map(COLUMNS.map((c) => [c.id, ScrollHandle.new()]));
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
    /** @type {Record<string, string> | null} */
    this.autoChoice = null;
    try { this.autoChoice = JSON.parse(localStorage.getItem(AUTO_COLORS_KEY) ?? "{}") ?? {}; } catch {}
    this.adding = Boolean(ui.adding); this.confirm = ui.confirm ?? null; this.mode = MODES[0].id;
    const savedTab = ui.bottomTab ?? this.loadText(BOTTOM_TAB_KEY);
    this.bottomTab = BOTTOM_TABS.includes(savedTab) ? savedTab : "commands";
    this.source = InputState.new({ placeholder: "Repository URL (git@github.com:org/repo.git)" });
    this.name = InputState.new({ placeholder: "Name (optional)" });
    this.picked = null;
    this.ask = InputState.new({ placeholder: "What to investigate or do" }); this.askProject = null;
    // The Kanban search applies on Enter or the find icon, so the first press lands on match 1.
    this.search = InputState.new({ placeholder: "Search tasks", value: ui.search ?? "" });
    this.focusedInputs = new Set();
    for (const input of [this.source, this.name, this.ask, this.search]) {
      input.on("focus", (_e, cx) => { this.focusedInputs.add(input); cx.notify(); });
      input.on("blur", (_e, cx) => { this.focusedInputs.delete(input); cx.notify(); });
    }
    /** @type {string} */
    this.query = (ui.search ?? "").trim(); this.matchAt = 0;
    this.search.on("submit", (_e, cx) => this.findNext(cx));
    this.viewer = new FolderViewer(); this.viewProject = null;
    if (checking() || !home()) return;
    // props.ui.view (testing): open the viewer on that project's local copy.
    if (ui.view) this.openView(ui.view, { path: `${home()}/projects/${ui.view}`, title: `${ui.view} · local copy` }, cx);
    if (ui.viewTab) this.viewer.tab = ui.viewTab;
    // props.ui.focus and props.ui.point (previews): Focus on that card, or that card pointed to.
    if (typeof ui.focus === "string") { this.focusMode = true; this.focusId = ui.focus; }
    if (typeof ui.point === "string") this.pointedId = ui.point;
    if (ui.pick) this.usePath(ui.pick, cx);
    this.listenCommands(cx);
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

  loadText(key) {
    try { return localStorage.getItem(key); }
    catch { return null; }
  }

  colorOf(name, t) {
    if (name === "firstmate" && !this.colorChoice[name]) return readableOnWhite(t.dim);
    return this.colorChoice[name] ?? this.autoChoice?.[name] ?? autoColor(name);
  }

  // Every project name the Board shows, from the registry and the cards.
  projectNames() {
    return [...this.projects.map((p) => p.name), ...(this.cards ?? []).map((c) => c.project).filter(Boolean)];
  }

  // Gives new names a saved color and, when live lists the projects of a good read, frees the colors
  // of every other name. Every Board copy shares the store, so the saved entries are read again and
  // win over this copy's; this copy's own are used only while the store holds none.
  updateColors(names, live) {
    if (!this.autoChoice) return;
    const isNew = (map) => (n) => n !== "firstmate" && !map[n];
    const gone = (map) => (live ? Object.keys(map).filter((n) => !live.has(n)) : []);
    if (!names.some(isNew(this.autoChoice)) && !gone(this.autoChoice).length) return;
    let next, picks;
    try {
      const saved = localStorage.getItem(AUTO_COLORS_KEY), savedPicks = localStorage.getItem(PROJECT_COLORS_KEY);
      // Herdr's getItem gives undefined, not null, for an unset key.
      next = saved == null ? { ...this.autoChoice } : JSON.parse(saved) ?? {};
      picks = savedPicks == null ? this.colorChoice : JSON.parse(savedPicks) ?? {};
    } catch { return; }
    for (const name of gone(next)) delete next[name];
    for (const name of [...new Set(names.filter(isNew(next)))].sort()) {
      const picked = Object.entries(picks).filter(([n]) => n !== name).map(([, c]) => c);
      const held = new Set([...Object.values(next), ...picked]);
      next[name] = PROJECT_COLORS.find((c) => !held.has(c)) ?? autoColor(name);
    }
    try { localStorage.setItem(AUTO_COLORS_KEY, JSON.stringify(next)); this.autoChoice = next; } catch {}
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
    if (this.revealed.delete(id) && this.folded.has(id)) { cx.notify(); return; }
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
    if (this.revealed.delete(id) && this.collapsed.has(id)) { cx.notify(); return; }
    if (!this.collapsed.delete(id)) this.collapsed.add(id);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this.collapsed])); } catch {}
    cx.notify();
  }

  // Goes through env so a test home never reaches the real inbox.
  fm(script, args, opts) {
    const root = home();
    return exec("/usr/bin/env", [`FM_HOME=${root}`, `${root}/bin/${script}`, ...args], { cwd: root, ...opts });
  }

  refresh(cx, { force = false } = {}) {
    if (this.loading || (!force && Date.now() - this.last < MIN_GAP_MS)) return;
    this.loading = true;
    /** @type {{ timer: import("gpui-kit").Task | null }} */
    const run = { timer: null };
    this.activeRefresh = run;
    const isCurrent = () => this.activeRefresh === run;
    // Overall deadline so a hung promise (e.g. a child holding stdout open) cannot wedge loading.
    run.timer = cx.timer.after(REFRESH_TIMEOUT_MS, (cx) => {
      if (!isCurrent()) return;
      this.activeRefresh = null;
      this.loading = false;
      this.last = Date.now();
      this.error = "refresh timed out";
      cx.notify();
    });
    cx.notify();
    cx.spawn(async (cx) => {
      const checksRead = this.loadChecks().then((info) => {
        if (!isCurrent()) return;
        this.checks = info?.checks ?? [];
        this.lastCheckSweep = info?.lastSweep ?? null;
        this.checksFailed = !info;
        cx.notify();
      });
      try {
        const snapshot = await this.loadSnapshot();
        if (!isCurrent()) return;
        if (snapshot.schema !== "fm-fleet-snapshot.v1") throw new Error(`unknown schema ${snapshot.schema}`);
        await this.readCoreStatus(snapshot);
        if (!isCurrent()) return;
        this.cards = cardsFrom(snapshot);
        this.generated = snapshot.generated ?? "";
        const projects = parseRegistry(await readTextFile(`${home()}/data/projects.md`));
        if (!isCurrent()) return;
        this.projects = projects;
        // An empty registry is more likely a bad read than every project removed, so it frees nothing.
        if (this.projects.length) this.updateColors([], new Set(this.projectNames()));
        const inbox = await this.loadInbox(isCurrent);
        if (!isCurrent()) return;
        if (inbox.requests !== undefined) this.requests = inbox.requests;
        this.ready = inbox.ready;
        this.beat = inbox.beat;
        this.watchers = inbox.watchers;
        this.error = null;
      } catch (e) {
        if (!isCurrent()) return;
        this.error = String(e?.message ?? e); // keep the last good board on screen
      }
      await checksRead;
      if (!isCurrent()) return;
      run.timer?.cancel?.();
      this.activeRefresh = null;
      this.loading = false; this.last = Date.now();
      cx.notify();
    });
  }

  async readCoreStatus(snapshot) {
    await Promise.all((snapshot.tasks ?? []).map(async (task) => {
      if (task.backend !== "hc" || task.current_state?.state !== "unknown") return;
      const address = hcAddress(task);
      if (!address) return;
      const r = await exec("hc", ["get", address, "--json"], { timeout: CORE_STATUS_TIMEOUT_MS }).catch(() => null);
      if (r?.code !== 0) return;
      const terminal = JSON.parse(r.stdout);
      // An address can be reused, so the terminal must still carry this task's label.
      if (terminal.labels?.["firstmate.task"] === `fm-${task.id}`) task.core_status = terminal.status?.state;
    }));
  }

  async loadSnapshot() {
    const file = props()?.snapshot_file;
    if (file) return JSON.parse(await readTextFile(file));
    const r = await this.fm("fm-fleet-snapshot.sh", ["--json"], { timeout: FM_EXEC_TIMEOUT_MS });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `snapshot exited ${r.code}`);
    return JSON.parse(r.stdout);
  }

  async loadInbox(isCurrent) {
    const receipts = await this.fm("fm-inbox.sh", ["receipts", "--all-pending"], { timeout: FM_EXEC_TIMEOUT_MS });
    if (!isCurrent()) return null;
    const ready = await this.fm("fm-inbox.sh", ["ready"], { timeout: FM_EXEC_TIMEOUT_MS });
    if (!isCurrent()) return null;
    let requests;
    if (receipts.code === 0) {
      const { pending = [] } = JSON.parse(receipts.stdout);
      requests = pending.filter((n) => n.request_id?.startsWith("board-"));
    }
    const readyData = ready.code === 0 ? JSON.parse(ready.stdout) : null;
    const isReady = readyData ? readyData.can_receive : null;
    const beat = readyData ? readyData.wake_consumer?.beacon_age_seconds ?? null : null;
    const watchers = await this.loadWatchers();
    return { requests, ready: isReady, beat, watchers };
  }

  // Registered checks from state/*.check.sh filenames and the home-wide sweep mtime from state/.last-check,
  // or null when they could not be read.
  async loadChecks() {
    try {
      const r = await exec("sh", ["-c", CHECKS_SCRIPT, "checks", `${home()}/state`], { timeout: PROCESS_LIST_TIMEOUT_MS });
      if (r?.code !== 0) return null;
      const fields = (r.stdout ?? "").split("\0");
      const names = [];
      let lastSweep = null;
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const kind = fields[i], value = fields[i + 1];
        if (kind === "last" && /^\d+$/.test(value)) {
          const epoch = Number(value);
          if (epoch > 0) lastSweep = epoch;
        } else if (kind === "check" && value) {
          names.push(value);
        }
      }
      names.sort((a, b) => a.localeCompare(b));
      return { checks: names.map((name) => ({ name })), lastSweep };
    } catch {
      return null;
    }
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
    if (!roles.length) return [];
    const r = await exec("ps", ["-o", "pid=,etime=", "-p", roles.map((x) => x.pid).join(",")], { timeout: PROCESS_LIST_TIMEOUT_MS }).catch(() => null);
    const alive = new Map((r?.stdout ?? "").trim().split("\n").filter(Boolean)
      .map((l) => l.trim().split(/\s+/)).map(([pid, etime]) => [pid, etime]));
    return roles.map((x) => ({ ...x, up: alive.get(x.pid) ?? null }));
  }

  send(text, cx, after, sent = "Request sent") {
    cx.spawn(async (cx) => {
      const r = await this.fm("fm-inbox.sh", ["note", "--json", "--request-id", `board-${Date.now()}`, "--", text]);
      // 3 means saved but not announced: the request exists and firstmate sees it at its next drain.
      if (r.code === 0 || r.code === 3) { this.notice = sent; after?.(); }
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
    return div().id(id).px(6).py(2).rounded(3).cursor_pointer().text_size(this.fs(11))
      .text_color(strong ? t.solid_foreground : t.muted).bg(strong ? t.solid : t.raised)
      .hover((s) => s.opacity(0.8)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  field(state, t) {
    return Input.new(state).h(28).px(8).rounded(4).border_1().border_color(t.input)
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
    return el.p(8).rounded(8).bg(t.background).border(1).border_color(t.border);
  }

  // A section heading in the Ledger theme: no fill, a hairline under it (or a thicker rule in a
  // column's status color).
  ledgerHead(el, t, color = t.border, width = 1) {
    return el.px(2).pt(2).pb(5).border_b(width).border_color(color);
  }

  // A count beside a heading, in the theme's data face.
  count(n, t) {
    return div().flex_none().font_family(DATA_FONT).text_size(this.fs(11)).text_color(t.dim).child(String(n));
  }

  // The Projects tab: project rows, the add form, and the Board requests firstmate has not handled.
  projectsBody(t) {
    // Plain overflow_y_scroll, not the scrollbar wrapper: the wrapper drops max_h, so the list
    // never got a height to scroll within.
    const list = v_flex().id("project-list").gap(8).max_h(260).min_h(0).flex_shrink(1).overflow_y_scroll();
    list.child(h_flex().justify_end().child(this.button("add-open", "+ Add", t, (cx) => { this.adding = !this.adding; cx.notify(); })));
    if (this.adding) list.child(this.addForm(t));
    list.children(this.projects.map((p) => this.projectRow(p, t)));
    if (this.requests.length) list.child(v_flex().gap(4).pt(6).border_t(1).border_color(t.border)
      .children(this.requests.map((n) => this.requestRow(n, t))));
    return list;
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

  // The Commands tab: slash-command buttons, the Scout/Task/Memo field, and its project chips.
  commandsBody(t) {
    const el = v_flex().id("commands-body").gap(8);
    const run = (command) => (cx) => this.typeCommand(command, cx);
    const request = (kind) => (cx) => {
      const text = this.ask.value().trim();
      if (!text) { this.notice = "Type what to investigate or do"; cx.notify(); return; }
      const project = this.askProject ?? "(firstmate picks)";
      this.typeToFirstmate(`[Board ${kind}] project=${project}: ${text}`,
        `[Board request] New ${kind}: project=${project} - ${text}`, `${kind === "scout" ? "Scout" : "Task"} request typed into firstmate`,
        cx, () => { this.ask.set_value(""); this.askProject = null; });
    };
    // A memo never types into the terminal: it is saved as an inbox note at once, so it survives
    // a firstmate that is stopped on a limit or closed.
    const memo = (cx) => {
      const text = this.ask.value().trim();
      if (!text) { this.notice = "Type the note to save"; cx.notify(); return; }
      const project = this.askProject ?? "(firstmate picks)";
      this.send(`[Board memo] project=${project}: ${text} - file this in the backlog only; do not start work`,
        cx, () => { this.ask.set_value(""); this.askProject = null; }, "Memo saved");
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
          .tooltip("Request a change to the project, delivered as a PR or branch"))
        .child(this.button("ask-memo", "Memo", t, memo, true)
          .tooltip("Save a note for firstmate to file in the backlog later, without starting work. Works even when firstmate is stopped")))
      .child(h_flex().gap(4).items_center().flex_wrap()
        .child(div().flex_none().text_size(this.fs(11)).text_color(t.dim).child(this.askProject ? "Project" : "Project (optional)"))
        .children(this.projects.map((p) => chip(p.name))));
  }

  card(c, t, inGroup, boxDimmed = false) {
    // A search shows matching cards open, without changing the remembered folds.
    const foldId = `card:${c.id}`, folded = this.folded.has(foldId) && !this.query && !this.revealed.has(foldId);
    const current = this.query && this.currentMatch === c.id;
    // A queued card that still waits on other work is dimmed.
    const waiting = c.column === "queued" && c.waitingOn.length > 0;
    const hasDeps = (c.waitingOn?.length ?? 0) > 0 || (c.blocksCount ?? 0) > 0;
    const role = this.highlight?.roles?.get(c.id) ?? null;
    const pinnedRole = this.pinned?.roles?.get(c.id) ?? null;
    const dimmed = Boolean(this.highlight?.dimmedIds?.has(c.id)) && !current;
    const roleBorder = role === "selected" ? t.accent : role === "upstream" ? t.working : role === "downstream" ? t.ansi6 : null;
    const pinnedBorder = pinnedRole === "selected" || pinnedRole === "upstream" || pinnedRole === "downstream";
    // The captain's-call ring, in the held color of the NEXT MOVE band: the card its card line
    // pointed to (for a few seconds), and the card j/k reached in Focus. Accent stays for hover,
    // selection, and the search match. In Focus every card that is not the captain's call steps back.
    const cursorRing = !this.focusMode && this.cursorId === c.id && this.keys.is_focused();
    const callRing = (this.focusMode && this.focusId === c.id) || this.pointedId === c.id;
    const focusDim = this.focusMode && !needsCaptain(c);
    const borderWidth = current || pinnedBorder || callRing || cursorRing ? 2 : 1;
    // A failed card keeps its red border unless the card is the current search match or sits on a highlighted chain.
    const borderColor = current || cursorRing ? t.accent : callRing ? t.blocked
      : roleBorder ?? (role === "branch" ? t.muted : c.failed ? t.ansi1 : t.border);
    // A deferred hold shows its date when it has one; a hold to answer now shows how long it has waited.
    const until = c.column === "held" && c.holdGroup === "deferred" ? c.holdUntil : null;
    const age = c.column === "held" && c.holdGroup === "now" ? waitAge(c.heldSince, Date.now()) : "";
    const readyLabel = c.prWaiting ? "PR waiting" : c.branchReady ? "Ready branch" : null;
    const badge = readyLabel
      ? div().id(`ready-${c.id}`).flex_none().text_size(this.fs(11)).font_semibold().text_color(t.blocked).child(readyLabel)
      : null;
    // The bar on the left edge carries the column's status color (red for a failed worker), so a
    // column reads at a glance; the body makes room for it.
    const barColor = c.failed ? t.ansi1 : t[COLUMNS.find((k) => k.id === c.column)?.color ?? "unknown"];
    const el = v_flex().id(`card-${c.id}`).relative().gap(4).p(8).pl(8 + CARD_BAR_PX + 2).rounded(4).bg(t.background)
      .border(borderWidth).border_color(borderColor)
      .child(div().id(`bar-${c.id}`).absolute().left(0).top(0).bottom(0).w(CARD_BAR_PX).rounded_l(4).bg(barColor))
      .when(focusDim && !boxDimmed, (e) => e.opacity(FOCUS_DIM))
      .when(!focusDim && dimmed, (e) => e.opacity(0.35))
      .when(!focusDim && !dimmed && waiting && !current && !role, (e) => e.opacity(0.6))
      .when(hasDeps, (e) => e.on_hover((hovered, cx) => this.hoverChainCard(c.id, hovered, cx)))
      .child(this.foldRow(foldId, t, folded, c.title, badge)
        .child(this.askButton(foldId, [c.id], c.title, t)));
    if (folded) return el;
    // The project sits on the state row so the title keeps the full card width.
    // In a narrow column the deferral date or wait wraps to its own line instead of being cut off.
    el.child(h_flex().id(`state-${c.id}`).gap(6).items_center().min_w(0).flex_wrap()
      .child(this.projectBadge(c.project || "firstmate", t, `tag-${c.id}`))
      .when(c.priority !== null && c.column !== "done", (e) => e.child(div().flex_none().px(4).rounded(3).border(1)
        .border_color(c.priority === 0 ? t.foreground : t.border).font_family(DATA_FONT).text_size(this.fs(10))
        .text_color(c.priority === 0 ? t.foreground : t.muted).tooltip("Backlog priority, 0 is highest").child(`P${c.priority}`)))
      // The red Failed label stands in for the "failed" state text.
      .child(c.failed
        ? div().id(`failed-${c.id}`).flex_none().px(5).py(1).rounded(4).bg(t.ansi1 + "24").text_size(this.fs(10)).font_semibold()
          .text_color(t.ansi1).tooltip("The worker reported failed").child("Failed")
        : div().flex_1().min_w(0).text_size(this.fs(11)).text_color(t.muted).truncate()
          .tooltip("Task state from firstmate").child(waiting ? "waiting" : c.state))
      // The year is left out: a deferral date is always ahead, and "until 12-01" fits a narrow card.
      .when(Boolean(until), (e) => e.child(div().id(`until-${c.id}`).flex_none().text_size(this.fs(11)).font_semibold()
        .text_color(t.muted).tooltip(`Deferred until ${until}`).child(`until ${String(until).replace(/^\d{4}-/, "")}`)))
      .when(Boolean(age), (e) => e.child(div().id(`age-${c.id}`).flex_none().font_family(DATA_FONT).text_size(this.fs(11))
        .font_semibold().text_color(t.blocked).tooltip(`Waiting on you for ${age}`).child(age))));
    if (hasDeps) {
      const depRow = h_flex().id(`deps-${c.id}`).gap(4).items_center().flex_wrap().min_w(0);
      if ((c.waitingOn?.length ?? 0) > 0) {
        const selected = this.selectedCardId === c.id;
        const waitsColor = mixColor(t.blocked, t.working);
        depRow.child(div().id(`waits-${c.id}`).min_w(0).px(5).py(1).rounded(4).border(1)
          .border_color(selected ? t.accent : waitsColor).bg(waitsColor + "18")
          .text_size(this.fs(10.5)).font_semibold().text_color(waitsColor).truncate()
          .cursor_pointer().hover((st) => st.opacity(0.8))
          .tooltip(`Inspect dependency chain · Waits on: ${c.waitingOn.join(", ")}`)
          .on_click((_e, cx) => { cx.stop_propagation(); this.selectChainCard(c.id, cx); })
          .child(waitingLabel(c, "← Waits on")));
      }
      if ((c.blocksCount ?? 0) > 0) {
        const selected = this.selectedCardId === c.id;
        depRow.child(div().id(`blocks-${c.id}`).flex_none().px(5).py(1).rounded(4).border(1)
          .border_color(selected ? t.accent : t.ansi6).bg(t.ansi6 + "18")
          .text_size(this.fs(10.5)).font_semibold().text_color(t.ansi6)
          .cursor_pointer().hover((st) => st.opacity(0.8))
          .tooltip(`Inspect dependency chain · Blocks: ${(c.blocksOn ?? []).join(", ")}`)
          .on_click((_e, cx) => { cx.stop_propagation(); this.selectChainCard(c.id, cx); })
          .child(blocksLabel(c)));
      }
      if (pinnedRole === "upstream" || pinnedRole === "selected" || pinnedRole === "downstream") {
        const roleLabel = pinnedRole === "upstream" ? "Upstream" : pinnedRole === "selected" ? "Selected" : "Downstream";
        const roleColor = pinnedRole === "upstream" ? t.working : pinnedRole === "selected" ? t.accent : t.ansi6;
        depRow.child(div().id(`hl-${c.id}`).flex_none().px(5).py(1).rounded(4).bg(roleColor + "24")
          .text_size(this.fs(10)).font_semibold().text_color(roleColor).child(roleLabel));
      }
      el.child(depRow);
    }
    // The same tint as the Live strip: the working color alone is too faint as text on a light theme.
    if (c.background) el.child(h_flex().id(`background-${c.id}`).gap(6).px(6).py(2).rounded(5).items_center().min_w(0)
      .bg(t.working + "1f").tooltip("Its agent's turn has ended, but the worker's terminal is still running this")
      .child(div().flex_none().w(6).h(6).rounded(3).bg(t.working))
      // In a narrow column the job's name moves to a second line whole, instead of being cut off.
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap_x(4).text_size(this.fs(11)).font_semibold().text_color(t.foreground)
        .child(div().flex_none().child("백그라운드 실행 중:")).child(div().min_w(0).truncate().child(c.background))));
    if (c.waitingFor && !inGroup) {
      el.child(h_flex().id(`waiting-${c.id}`).gap(4).items_center().min_w(0).tooltip(c.waitingFor)
        .child(div().flex_none().text_size(this.fs(11)).font_semibold().text_color(t.muted).child("Waiting for:"))
        .child(div().flex_1().min_w(0).truncate().text_size(this.fs(11)).text_color(t.dim).child(prioritizeWaitingClause(c.waitingFor))));
    } else if (c.detail && !inGroup) {
      el.child(div().text_size(this.fs(11)).text_color(t.dim).child(c.detail.slice(0, 140)));
    }
    const ownDecision = c.decision && !c.decision.topic;
    if (ownDecision) this.decisionLines(el, c.decision, t, `card:${c.id}`, [c.id], c.column === "held");
    c.openDecisions.forEach((d, i) => this.openDecision(el, c, d, i, t));
    if (c.pr && /^https:\/\//.test(c.pr)) {
      el.child(div().id(`pr-${c.id}`).text_size(this.fs(11)).text_color(t.accent).truncate()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.openPr(c.pr, c, cx))
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

  // One option's answer draft, the same from a card, a topic box, or the NEXT MOVE banner.
  /** @param {string[]} ids @param {{ label: string, text: string }} o @param {string} decisionKey */
  answerOption(ids, o, decisionKey, cx) {
    this.insertCardText(`${answerHead(ids, decisionKey)} ${o.label} (${o.text})`, cx);
  }

  // Holds to answer now, longest-waiting first (unstamped ones last, in backlog order).
  waitingHolds() {
    const stamp = (c) => { const ms = Date.parse(c.heldSince ?? ""); return Number.isNaN(ms) ? Infinity : ms; };
    return (this.cards ?? []).filter((c) => c.column === "held" && c.holdGroup === "now")
      .map((c, i) => ({ c, i })).sort((a, b) => stamp(a.c) - stamp(b.c) || a.i - b.i).map((x) => x.c);
  }

  // The holds one answer covers: every hold to answer now that shares the card's topic, in backlog
  // order as the Held column's topic box lists them, else the card alone.
  /** @param {any} c */
  topicHolds(c) {
    const topic = c.decision?.topic;
    return topic ? (this.cards ?? []).filter((x) => x.column === "held" && x.holdGroup === "now" && x.decision?.topic === topic) : [c];
  }

  /** @param {any} c */
  answerIds(c) {
    return this.topicHolds(c).map((x) => x.id);
  }

  // The decision an answer to the card follows, as the Held column's topic box shows it.
  /** @param {any} c */
  answerDecision(c) {
    return sharedDecision(this.topicHolds(c)) ?? c.decision;
  }

  // The option a decision recommends ("B", or "B" followed by a reason), if it names one.
  /** @param {any} decision */
  recommendedOption(decision) {
    const rec = String(decision?.recommended ?? "").trim();
    return (decision?.options ?? []).find((o) => new RegExp(`^${o.label}(?![A-Za-z])`).test(rec)) ?? null;
  }

  // Five counts across the top: what landed today, what waits on the captain, what runs, what is
  // ready to land, and what is blocked. Done today follows the backlog's own (Korea-time) dates.
  /** @param {Record<string, string>} t @param {any[]} holds @param {boolean} stacked */
  todayStrip(t, holds, stacked) {
    const cards = this.cards ?? [];
    const now = Date.now(), today = koreaDate(now);
    const of = (col) => cards.filter((c) => c.column === col);
    const working = of("working"), blocked = of("blocked");
    const jobs = working.filter((c) => c.background).length;
    const failed = blocked.filter((c) => c.failed).length;
    const oldest = holds[0] ? waitAge(holds[0].heldSince, now) : "";
    const cells = [
      ["done", "Done today", of("done").filter((c) => c.completedOn === today).length, "", "done"],
      ["waiting", "Waiting on you", holds.length, oldest ? `oldest ${oldest}` : "", "blocked"],
      ["working", "Working", working.length, jobs ? `${jobs} background job${jobs === 1 ? "" : "s"}` : "", "working"],
      ["ready", "Ready to land", cards.filter((c) => c.prWaiting || c.branchReady || c.column === "review").length, "", "done"],
      ["blocked", "Blocked", blocked.length, failed ? `${failed} failed` : "", "ansi1"],
    ];
    const blank = String.fromCharCode(0xa0); // keeps an empty sub-line one line tall
    return h_flex().id("today").flex_none().rounded(8).bg(t.background).border(1).border_color(t.border)
      .when(stacked, (e) => e.flex_wrap())
      .children(cells.map(([id, label, n, sub, color], i) => v_flex().id(`today-${id}`).flex_1().min_w(stacked ? 110 : 0)
        .gap(2).px(12).py(8)
        .when(i > 0, (e) => e.border_l(1).border_color(t.border))
        .when(this.focusMode && id !== "waiting" && id !== "blocked", (e) => e.opacity(FOCUS_DIM))
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().w(7).h(7).rounded(2).bg(t[color]))
          .child(div().min_w(0).truncate().text_size(this.fs(11)).font_weight(500).text_color(t.muted).child(label)))
        .child(div().font_family(DATA_FONT).text_size(this.fs(21)).font_weight(500).text_color(t.foreground).child(String(n)))
        .child(div().min_w(0).truncate().text_size(this.fs(10)).text_color(t.dim).child(sub || blank))));
  }

  // The longest-waiting hold to answer now, at the top of the board in the Ledger idiom: a hairline
  // frame with a bar in the held status color. Its first line names the card the decision comes
  // from and brings that card into view; its options and Write answer put the same drafts in the
  // firstmate input as the Held card does.
  /** @param {Record<string, string>} t @param {any[]} holds */
  nextMove(t, holds) {
    const c = holds[0];
    if (!c) return null;
    const ids = this.answerIds(c), decision = this.answerDecision(c);
    const options = decision?.options ?? [];
    const rec = this.recommendedOption(decision);
    const age = waitAge(c.heldSince, Date.now());
    const action = (id, label, tooltip, onClick, primary) => h_flex().id(id).flex_none().gap(6).items_center()
      .px(8).py(4).rounded(3).cursor_pointer().border(1).border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.raised).text_size(this.fs(11.5)).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.8)).tooltip(tooltip)
      .on_click((_e, cx) => onClick(cx))
      .children(label.map((x) => (typeof x === "string" ? div().child(x) : x)));
    const letter = (o, primary) => div().font_family(DATA_FONT).font_semibold()
      .text_color(primary ? t.solid_foreground : t.accent).child(o.label);
    return h_flex().id("next-move").relative().flex_none().flex_wrap().gap(14).items_center()
      .pl(14 + CARD_BAR_PX).pr(12).py(10).rounded(8).bg(t.background).border(1).border_color(t.border)
      .child(div().id("next-move-bar").absolute().left(0).top(0).bottom(0).w(CARD_BAR_PX).rounded_l(8).bg(t.blocked))
      .child(v_flex().flex_1().min_w(240).gap(5)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(h_flex().id("next-move-card").flex_1().min_w(0).gap(8).items_center().cursor_pointer()
            .hover((s) => s.opacity(0.75)).tooltip(`Show ${c.id} on the board`)
            .on_click((_e, cx) => this.revealCard(c.id, cx))
            .child(this.projectBadge(c.project || "firstmate", t, `next-tag-${c.id}`))
            .child(div().flex_none().font_family(DATA_FONT).text_size(this.fs(11)).text_color(t.dim).child(c.id))
            .child(div().min_w(0).truncate().text_size(this.fs(11.5)).font_semibold().text_color(t.muted).child(c.title)))
          .when(Boolean(age), (e) => e.child(div().flex_none().font_family(DATA_FONT).text_size(this.fs(11)).font_semibold()
            .text_color(t.blocked).child(`waiting ${age}`)))
          .child(div().flex_none().text_size(this.fs(11)).text_color(t.dim).child(`Next move, 1 of ${holds.length}`)))
        .child(div().id("next-move-question").text_size(this.fs(14)).font_semibold().text_color(t.foreground)
          .child(decision?.question || c.detail || c.title)))
      .child(h_flex().flex_none().gap(6).items_center().flex_wrap()
        .children(options.map((o) => {
          const primary = o === rec;
          return action(`next-opt-${o.label}`, [letter(o, primary), o.text], "Put this answer in the firstmate input",
            (cx) => this.answerOption(ids, o, "", cx), primary);
        }))
        .child(action("next-write", ["Write answer"], "Start an answer in the firstmate input",
          (cx) => this.insertCardText(answerHead(ids), cx), false)));
  }

  // Brings a card on the Kanban board into view and rings it in the held color for a few seconds
  // (or until Escape), for a reference such as the NEXT MOVE card line.
  /** @param {string} id @param {import("gpui-kit").Context} cx */
  revealCard(id, cx) {
    const card = (this.cards ?? []).find((c) => c.id === id);
    if (!card) return;
    if (this.viewMode !== "kanban") this.setViewMode("kanban", cx);
    const at = Date.now();
    this.pointedId = id;
    this.pointedAt = at;
    // Only the latest point clears its ring: an older timer finds a newer point and leaves it.
    cx.timer.after(POINT_RING_MS, (later) => {
      if (this.pointedId !== id || this.pointedAt !== at) return;
      this.pointedId = null;
      later.notify();
    });
    this.keys.focus();
    this.showCard(card, cx);
    cx.notify();
  }

  // The captain's calls in the order Kanban draws them; Focus steps through these.
  captainCards() {
    return this.shownColumns().flatMap((col) => this.columnCards(col.id)).filter(needsCaptain);
  }

  /** @param {import("gpui-kit").Context} cx */
  toggleFocus(cx) {
    this.focusMode = !this.focusMode;
    this.focusId = null;
    if (this.focusMode) {
      this.detailCardId = null;
      this.keys.focus();
      this.moveFocus(0, cx);
    }
    cx.notify();
  }

  // Moves the Focus selection through the captain's calls (starting at the NEXT MOVE card), shows
  // its card, and peeks at its worker: Herdr draws the terminal over the tab beside the Board
  // without taking the keyboard, so j and k keep working.
  /** @param {number} delta @param {import("gpui-kit").Context} cx */
  moveFocus(delta, cx) {
    const calls = this.captainCards();
    const at = calls.findIndex((c) => c.id === this.focusId);
    const start = Math.max(0, calls.findIndex((c) => c.id === this.waitingHolds()[0]?.id));
    const c = calls[at < 0 ? start : Math.min(calls.length - 1, Math.max(0, at + delta))];
    this.focusId = c?.id ?? null;
    if (c) {
      this.revealed = new Set([`card:${c.id}`, c.column]);
      if (c.decision?.topic) this.revealed.add(`group:${c.decision.topic}`);
      this.scrollToCard(c);
      if (this.workerLive(c)) run("terminal.peek", { terminal: c.terminal });
    }
    cx.notify();
  }

  /** @param {import("gpui-kit").AsyncContext} cx */
  listenCommands(cx) {
    if (typeof nextCommand !== "function") return;
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === null || cmd === undefined) break;
        this.handleCommand(cmd, cx);
      }
    });
  }

  /** @param {string} cmd @param {import("gpui-kit").Context | import("gpui-kit").AsyncContext} cx */
  handleCommand(cmd, cx) {
    if (cmd !== "focus") return;
    this.keys.focus();
    if (!this.focusMode) {
      if (this.cards) this.placeCursor();
      else this.pendingInitialCursor = true;
    }
    cx.notify();
  }

  // Keeps the cursor on the open detail's card, or on a drawn card, starting with the first.
  placeCursor() {
    if (this.detailCardId) { this.cursorId = this.detailCardId; return; }
    const cards = this.boardCards();
    const c = cards.find((x) => x.id === this.cursorId) ?? cards[0];
    this.cursorId = c?.id ?? null;
    if (c) this.showCursorCard(c);
  }

  // Cards in one Kanban column in drawing order (section by section, topic groups inline).
  /** @param {string} id */
  columnCards(id) {
    return this.sections(id).flatMap((s) => this.entries(s.cards))
      .flatMap((x) => (x.topic ? x.cards : [x.card]));
  }

  // Expanded, non-empty Kanban columns in drawing order, each with its drawn cards.
  kanbanColumns() {
    return this.shownColumns()
      .filter((col) => !this.collapsed.has(col.id) || Boolean(this.query) || this.revealed.has(col.id))
      .map((col) => ({ col, cards: this.columnCards(col.id) }))
      .filter((x) => x.cards.length > 0);
  }

  // Cards in drawing order for keyboard navigation outside Focus mode.
  boardCards() {
    if (this.viewMode === "chains") {
      const stacked = (this.size?.width ?? Infinity) < STACK_BELOW_PX;
      const seen = new Set();
      const out = [];
      const cardById = new Map((this.cards ?? []).map((c) => [c.id, c]));
      for (const comp of this.visibleChains()) {
        if (this.chainLaneFolded(comp)) continue;
        const lane = placeChainLane(comp, this.graph?.nodes ?? new Map());
        const ids = stacked
          ? lane.steps.flatMap((step) => step.nodes.map((n) => n.id))
          : lane.grid.flat().filter(Boolean);
        for (const id of ids) {
          if (seen.has(id)) continue;
          const card = cardById.get(id);
          if (card) { seen.add(id); out.push(card); }
        }
      }
      if (this.independentOpen || this.query) {
        for (const c of this.independentCards()) {
          if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
        }
      }
      return out;
    }
    return this.kanbanColumns().flatMap((x) => x.cards);
  }

  /** @param {any} c @param {import("gpui-kit").Context} cx */
  selectCursorCard(c, cx) {
    this.cursorId = c.id;
    if (this.detailCardId && this.detailCardId !== c.id) this.detailCardId = null;
    this.showCursorCard(c);
    cx.notify();
  }

  // Moves the Kanban cursor within a column (dy) or across expanded non-empty columns (dx).
  /** @param {number} dx @param {number} dy @param {import("gpui-kit").Context} cx */
  moveKanbanCursor(dx, dy, cx) {
    const cols = this.kanbanColumns();
    if (!cols.length) { this.cursorId = null; cx.notify(); return; }
    const colIdx = cols.findIndex((x) => x.cards.some((c) => c.id === this.cursorId));
    if (colIdx < 0) { this.selectCursorCard(cols[0].cards[0], cx); return; }
    const rowIdx = cols[colIdx].cards.findIndex((c) => c.id === this.cursorId);
    if (dx !== 0) {
      const target = cols[colIdx + dx];
      if (!target) return;
      this.selectCursorCard(target.cards[Math.min(rowIdx, target.cards.length - 1)], cx);
      return;
    }
    const curCards = cols[colIdx].cards;
    this.selectCursorCard(curCards[Math.min(curCards.length - 1, Math.max(0, rowIdx + dy))], cx);
  }

  /** @param {number} delta @param {import("gpui-kit").Context} cx */
  moveCursor(delta, cx) {
    const cards = this.boardCards();
    if (!cards.length) { this.cursorId = null; cx.notify(); return; }
    const at = cards.findIndex((c) => c.id === this.cursorId);
    const next = at < 0
      ? (delta < 0 ? cards.length - 1 : 0)
      : Math.min(cards.length - 1, Math.max(0, at + delta));
    this.selectCursorCard(cards[next], cx);
  }

  // Kanban opens the card's column and topic group and scrolls its column or list to the card;
  // Chains scrolls its board to the card's lane, or to the Independent drawer, counting the
  // legend or empty note drawn above the lanes.
  /** @param {any} c */
  showCursorCard(c) {
    if (this.viewMode === "kanban") {
      this.revealed = new Set([c.column, ...(this.detailCardId ? [`card:${this.detailCardId}`] : [])]);
      if (c.decision?.topic) this.revealed.add(`group:${c.decision.topic}`);
      this.scrollToCard(c);
      return;
    }
    const chains = this.visibleChains();
    const lead = chains.length || !this.query ? 1 : 0;
    const laneIdx = chains.findIndex((comp) => comp.nodeIds.includes(c.id));
    this.chainsScroll.scroll_to_item(lead + (laneIdx >= 0 ? laneIdx : chains.length));
  }

  /** @param {any} c @param {import("gpui-kit").Context} cx */
  openCardDetail(c, cx) {
    if (!c) return;
    if (this.viewMode === "chains") {
      if (this.selectedCardId !== c.id) this.selectChainNode(c.id, cx);
      return;
    }
    this.detailCardId = c.id;
    this.showCard(c, cx);
    cx.notify();
  }

  returnToTerminal() {
    const target = focused();
    if (target?.terminal) run("pane.focus", { terminal: target.terminal });
  }

  // A TASK DETAIL header with a Close button above a card's detail, in Kanban and in a Chains lane.
  /** @param {string} elId @param {string} id @param {any} body @param {Record<string, `#${string}`>} t @param {(cx: import("gpui-kit").Context) => void} close */
  taskDetail(elId, id, body, t, close) {
    return v_flex().id(elId).gap(6)
      .child(h_flex().gap(8).items_center().justify_between()
        .child(div().font_family(DATA_FONT).text_size(this.fs(9.5)).text_color(t.accent).child(`TASK DETAIL · ${id}`))
        .child(this.button(`${elId}-close`, "Close", t, close)))
      .child(body);
  }

  // Board keys reach the Board only while it holds the keyboard itself, never while a field does.
  /** @param {import("gpui-kit").KeyEvent} e @param {import("gpui-kit").Context} cx */
  focusKey(e, cx) {
    if (!this.keys.is_focused()) return false;
    if (e.modifiers?.control || e.modifiers?.platform || e.modifiers?.alt) return false;
    if (e.key === "escape") {
      if (this.viewer.root) { this.viewer.close(cx); return true; }
      if (this.detailCardId) { this.detailCardId = null; cx.notify(); return true; }
      if (this.focusMode) { this.toggleFocus(cx); return true; }
      if (this.inspectorOpen || this.selectedCardId) { this.clearChainSelection(cx); return true; }
      if (this.pointedId) { this.pointedId = null; cx.notify(); return true; }
      this.returnToTerminal();
      return true;
    }
    if (e.key === "f" && this.viewMode === "kanban") { this.toggleFocus(cx); return true; }
    if (this.focusMode) {
      if (this.viewMode !== "kanban") return false;
      if (e.key === "j" || e.key === "down") { this.moveFocus(1, cx); return true; }
      if (e.key === "k" || e.key === "up") { this.moveFocus(-1, cx); return true; }
      const c = (this.cards ?? []).find((x) => x.id === this.focusId);
      if (!c) return false;
      if (e.key === "enter") {
        const ids = this.answerIds(c), rec = this.recommendedOption(this.answerDecision(c));
        if (rec) this.answerOption(ids, rec, "", cx); else this.insertCardText(answerHead(ids), cx);
        return true;
      }
      if (e.key === "o" && c.terminal) { this.openWorker(c, cx); return true; }
      return false;
    }
    if (this.viewMode === "kanban") {
      if (e.key === "j" || e.key === "down") { this.moveKanbanCursor(0, 1, cx); return true; }
      if (e.key === "k" || e.key === "up") { this.moveKanbanCursor(0, -1, cx); return true; }
      if (e.key === "h" || e.key === "left") { this.moveKanbanCursor(-1, 0, cx); return true; }
      if (e.key === "l" || e.key === "right") { this.moveKanbanCursor(1, 0, cx); return true; }
    } else {
      if (e.key === "j" || e.key === "down") { this.moveCursor(1, cx); return true; }
      if (e.key === "k" || e.key === "up") { this.moveCursor(-1, cx); return true; }
    }
    const c = (this.cards ?? []).find((x) => x.id === this.cursorId);
    if (!c) return false;
    if (e.key === "enter") { this.openCardDetail(c, cx); return true; }
    if (e.key === "o" && c.terminal) { this.openWorker(c, cx); return true; }
    return false;
  }

  // Options of a held decision become editable chat drafts; the owner confirms them with Enter.
  // Elsewhere they are plain text: set-aside work in Todo waits until it is brought back.
  // An open decision's options carry its key in the draft, so firstmate can close that decision.
  /** @param {string[]} ids @param {boolean} answerable @param {string} [decisionKey] */
  decisionLines(el, decision, t, key, ids, answerable, decisionKey = "") {
    for (const o of decision.options) {
      el.child(h_flex().id(`opt-${key}-${o.label}`).gap(6).px(4).py(2).rounded(5)
        .when(answerable, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Put this answer in the firstmate input")
          .on_click((_e, cx) => this.answerOption(ids, o, decisionKey, cx)))
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
    this.clearChainSelection(cx);
    this.viewProject = project;
    this.viewer.target(source.path, source.title, cx);
  }

  /** @param {"kanban" | "chains"} mode @param {import("gpui-kit").Context} cx */
  setViewMode(mode, cx) {
    if (mode !== "kanban" && mode !== "chains") return;
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.hoveredCardId = null;
    this.detailCardId = null;
    if (mode === "kanban" && !this.inspectorOpen) this.selectedCardId = null;
    if (mode === "chains") { this.inspectorOpen = false; this.focusMode = false; this.focusId = null; }
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch {}
    cx.notify();
  }

  /** @param {import("gpui-kit").Context} cx */
  toggleIndependent(cx) {
    if (this.query) return;
    this.independentOpen = !this.independentOpen;
    try { localStorage.setItem(INDEPENDENT_OPEN_KEY, String(this.independentOpen)); } catch {}
    cx.notify();
  }

  /** @param {string} id @param {import("gpui-kit").Context} cx */
  selectChainNode(id, cx) {
    if (this.selectedCardId === id) {
      this.selectedCardId = null;
      this.hoveredCardId = null;
      cx.notify();
      return;
    }
    this.selectedCardId = id;
    this.revealed.add(`card:${id}`);
    this.keys.focus();
    cx.notify();
  }

  /** @param {string} id @param {import("gpui-kit").Context} cx */
  selectChainCard(id, cx) {
    if (this.viewMode === "chains") {
      this.selectChainNode(id, cx);
      return;
    }
    if (this.selectedCardId === id && this.inspectorOpen) {
      this.clearChainSelection(cx);
      return;
    }
    this.selectedCardId = id;
    this.inspectorOpen = true;
    this.keys.focus();
    if (this.viewer.root) this.viewer.close(cx);
    else cx.notify();
  }

  /** @param {string} id @param {boolean} hovered @param {import("gpui-kit").Context} cx */
  hoverChainCard(id, hovered, cx) {
    const next = hovered ? id : (this.hoveredCardId === id ? null : this.hoveredCardId);
    if (next === this.hoveredCardId) return;
    this.hoveredCardId = next;
    cx.notify();
  }

  /** @param {import("gpui-kit").Context} cx */
  toggleInspector(cx) {
    if (this.inspectorOpen) {
      this.clearChainSelection(cx);
      return;
    }
    this.inspectorOpen = true;
    this.keys.focus();
    if (!this.selectedCardId || !this.graph?.componentById?.has(this.selectedCardId)) {
      const firstComp = this.graph?.components?.[0];
      this.selectedCardId = firstComp?.roots?.[0] ?? firstComp?.nodeIds?.[0] ?? null;
    }
    if (this.viewer.root) this.viewer.close(cx);
    else cx.notify();
  }

  /** @param {import("gpui-kit").Context} cx */
  clearChainSelection(cx) {
    if (!this.selectedCardId && !this.hoveredCardId && !this.inspectorOpen) return;
    this.selectedCardId = null;
    this.hoveredCardId = null;
    this.inspectorOpen = false;
    cx.notify();
  }

  /** @param {string} id @param {import("gpui-kit").Context} cx */
  focusCardFromInspector(id, cx) {
    this.selectedCardId = id;
    this.inspectorOpen = true;
    this.keys.focus();
    const card = (this.cards ?? []).find((c) => c.id === id);
    if (card) this.showCard(card, cx);
    cx.notify();
  }

  // Shows a card wherever a filter, search, or fold hides it, without saving those folds, and
  // scrolls to it.
  /** @param {any} card @param {import("gpui-kit").Context} cx */
  showCard(card, cx) {
    if (this.filter && this.filter !== card.project) this.filter = null;
    if (this.query && !searchText(card).includes(this.query.toLowerCase())) this.clearSearch(cx);
    this.revealed = new Set([`card:${card.id}`, card.column]);
    if (card.decision?.topic) this.revealed.add(`group:${card.decision.topic}`);
    this.scrollToCard(card);
  }

  // Brings a card's column on screen in the stacked board, or its entry (a card, a topic group,
  // or a Held group) in its column's list; the handles reveal a direct child by index.
  scrollToCard(card) {
    if ((this.size?.width ?? Infinity) < STACK_BELOW_PX) {
      const colIdx = this.shownColumns().findIndex((col) => col.id === card.column);
      if (colIdx >= 0) this.boardScroll.scroll_to_item(colIdx);
      return;
    }
    const handle = this.colScrolls.get(card.column);
    const secs = this.sections(card.column);
    const idx = secs.length === 1 && !secs[0].title
      ? this.entries(secs[0].cards).findIndex((x) => (x.topic ? x.cards : [x.card]).some((m) => m.id === card.id))
      : secs.findIndex((s) => s.cards.some((m) => m.id === card.id));
    if (handle && idx >= 0) handle.scroll_to_item(idx);
  }

  /** @param {any} node @param {Record<string, `#${string}`>} t @param {boolean} [showPrWaiting] */
  nodeStatus(node, t, showPrWaiting = false) {
    const colDef = COLUMNS.find((k) => k.id === node.column);
    if (node.missing) return ["external", t.muted];
    if (showPrWaiting && node.prWaiting) return ["PR waiting", t.done];
    if (showPrWaiting && node.branchReady) return ["Ready branch", t.done];
    if (node.failed) return ["failed", t.ansi1];
    if (node.column === "queued") {
      return (node.waitingIds?.length ?? 0) > 0 ? ["waiting", t.blocked] : ["ready", colDef ? t[colDef.color] : t.muted];
    }
    const label = node.column || node.state || "unknown";
    const color = (colDef ? t[colDef.color] : t.muted) ?? t.muted;
    return [label, color];
  }

  /** @param {any} node @param {any} comp @param {Record<string, `#${string}`>} t @param {boolean} [compact] */
  renderDagNode(node, comp, t, compact = false) {
    const id = node.id;
    const role = this.highlight?.roles?.get(id) ?? null;
    const pinnedRole = this.pinned?.roles?.get(id) ?? null;
    const isSelected = this.selectedCardId === id;
    const borderCol = isSelected || role === "selected" ? t.accent
      : role === "upstream" ? t.working
      : role === "downstream" ? t.ansi6
      : t.border;
    const roleLabel = isSelected || pinnedRole === "selected" ? "Selected"
      : pinnedRole === "upstream" ? "Upstream"
      : pinnedRole === "downstream" ? "Downstream"
      : pinnedRole === "branch" ? "Branch" : null;
    const roleColor = isSelected || pinnedRole === "selected" ? t.accent
      : pinnedRole === "upstream" ? t.working
      : pinnedRole === "downstream" ? t.ansi6
      : t.muted;
    const [stateLabel, stateColor] = this.nodeStatus(node, t, false);
    const strip = (title) => (node.project && title.startsWith(`${node.project} `) ? title.slice(node.project.length + 1) : title);
    const box = v_flex().id(`dep-node-${id}`).when(!compact, (e) => e.flex_1().min_w(160)).when(compact, (e) => e.min_w(0)).gap(3).p(compact ? 5 : 7).rounded(6)
      .bg(isSelected ? t.selected : t.background).border(isSelected || pinnedRole === "upstream" || pinnedRole === "downstream" ? 2 : 1)
      .border_color(borderCol).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(`${id}: ${node.title} · Click to highlight & scroll to card`)
      .on_hover((hovered, cx) => this.hoverChainCard(id, hovered, cx))
      .on_click((_e, cx) => { cx.stop_propagation(); this.focusCardFromInspector(id, cx); });
    const topRow = h_flex().gap(5).items_center().min_w(0)
      .child(node.missing
        ? div().id(`dep-tag-${id}`).flex_none().px(4).py(1).rounded(9).border(1).border_color(t.border)
          .text_size(this.fs(10)).text_color(t.muted).tooltip("Not on the board").child("unknown")
        : this.projectBadge(node.project || "firstmate", t, `dep-tag-${id}`))
      .child(div().flex_1().min_w(0).truncate().text_size(this.fs(10.5)).font_semibold().text_color(t.muted).child(id))
      .child(div().flex_none().px(4).py(0.5).rounded(4).bg(stateColor + "22").text_size(this.fs(10)).font_semibold().text_color(stateColor).child(stateLabel));
    if (roleLabel) {
      topRow.child(div().id(`dep-role-${id}`).flex_none().px(4).py(0.5).rounded(4).bg(roleColor + "24")
        .text_size(this.fs(9.5)).font_semibold().text_color(roleColor).child(roleLabel));
    }
    box.child(topRow)
      .child(div().min_w(0).truncate().text_size(this.fs(11.5)).font_semibold().text_color(t.foreground).child(strip(node.title ?? id)));
    if (!compact) {
      const edgePills = [];
      if ((node.waitingIds?.length ?? 0) > 0) {
        edgePills.push(div().flex_none().text_size(this.fs(10)).text_color(t.blocked).child(`← Waits on ${node.waitingIds.join(", ")}`));
      }
      if ((node.blocksCount ?? 0) > 0) {
        edgePills.push(div().flex_none().text_size(this.fs(10)).text_color(t.ansi6).child(`★ Blocks ${node.blocksCount} →`));
      }
      if ((node.crossProjectBlockers?.length ?? 0) > 0) {
        edgePills.push(div().id(`dep-xproj-${id}`).flex_none().px(4).py(0.5).rounded(4).bg(t.blocked + "20")
          .text_size(this.fs(9.5)).font_semibold().text_color(t.blocked).child(`Cross-project ← ${node.crossProjectBlockers.join(", ")}`));
      }
      if (edgePills.length) box.child(h_flex().gap(6).items_center().flex_wrap().children(edgePills));
    }
    return box;
  }

  /** @param {any | null} comp @param {Record<string, `#${string}`>} t */
  renderInspector(comp, t) {
    const components = this.graph?.components ?? [];
    const activeComp = comp ?? components[0] ?? null;
    const header = h_flex().gap(6).items_center().px(8).py(6).rounded(6).bg(t.selected)
      .child(div().flex_1().min_w(0).truncate().text_size(this.fs(12.5)).font_semibold().text_color(t.foreground).child("Dependency Inspector"))
      .when(Boolean(activeComp), (el) => el.child(div().id("dep-inspector-summary").flex_none().px(6).py(1).rounded(5).bg(t.raised)
        .text_size(this.fs(10.5)).font_semibold().text_color(t.accent)
        .child(`${activeComp.summaryLabel} · depth ${activeComp.depth}`)))
      .child(this.button("dep-inspector-close", "Close", t, (cx) => this.clearChainSelection(cx)));
    const panel = this.frame(v_flex().id("dep-inspector").size_full().min_h(0).gap(8), t)
      .child(header);
    if (!activeComp) {
      return panel.child(div().p(12).text_size(this.fs(11.5)).text_color(t.muted)
        .child(NO_CHAINS_TEXT));
    }
    if (components.length > 1) {
      panel.child(h_flex().id("dep-chain-tabs").gap(4).items_center().flex_wrap()
        .child(div().flex_none().text_size(this.fs(10.5)).text_color(t.dim).child("Chains"))
        .children(components.map((cComp) => {
          const on = cComp.id === activeComp.id;
          const targetId = cComp.roots?.[0] ?? cComp.nodeIds?.[0];
          return div().id(`dep-chain-${cComp.id}`).flex_none().px(6).py(2).rounded(5).cursor_pointer()
            .bg(on ? t.selected : t.raised).border(1).border_color(on ? t.accent : t.border)
            .text_size(this.fs(10.5)).font_semibold().text_color(on ? t.foreground : t.muted)
            .hover((s) => s.opacity(0.85))
            .on_click((_e, cx) => { if (targetId) this.focusCardFromInspector(targetId, cx); })
            .child(`${cComp.summaryLabel} (${cComp.nodeIds.length})`);
        })));
    }
    const metaBadges = [];
    if (activeComp.hasCycle) {
      metaBadges.push(div().id("dep-cycle-badge").flex_none().px(5).py(1).rounded(4).bg(t.ansi1 + "24")
        .text_size(this.fs(10)).font_semibold().text_color(t.ansi1).child("Cycle guard active"));
    }
    if (activeComp.crossProjectEdges?.length) {
      metaBadges.push(div().id("dep-cross-project-badge").flex_none().px(5).py(1).rounded(4).bg(t.blocked + "22")
        .text_size(this.fs(10)).font_semibold().text_color(t.blocked)
        .child(`Cross-project (${activeComp.crossProjectEdges.length})`));
    }
    if (activeComp.joins?.length) {
      metaBadges.push(div().id("dep-join-badge").flex_none().px(5).py(1).rounded(4).bg(t.ansi6 + "22")
        .text_size(this.fs(10)).font_semibold().text_color(t.ansi6)
        .child(`Join (${activeComp.joins.length})`));
    }
    const legendDot = (label, color) => h_flex().flex_none().gap(4).items_center()
      .child(div().w(6).h(6).rounded(3).bg(color))
      .child(div().text_size(this.fs(10)).text_color(t.muted).child(label));
    panel.child(h_flex().gap(8).items_center().flex_wrap()
      .child(legendDot("Upstream", t.working))
      .child(legendDot("Selected", t.accent))
      .child(legendDot("Downstream", t.ansi6))
      .children(metaBadges));
    const dagList = v_flex().id("dep-inspector-levels").flex_1().min_h(0).gap(6).overflow_y_scrollbar();
    activeComp.levels.forEach((lg, idx) => {
      if (idx > 0) {
        const edgeDesc = lg.hasCrossProject ? "↓ Cross-project dependency"
          : lg.hasJoin ? "↓ Fan-in join"
          : lg.hasBranch ? "↓ Parallel fan-out"
          : "↓ Unblocks";
        dagList.child(h_flex().px(6).gap(6).items_center()
          .child(div().text_size(this.fs(10.5)).font_semibold().text_color(lg.hasCrossProject ? t.blocked : t.dim).child(edgeDesc)));
      }
      const levelRole = lg.level === 0 ? "Root blocker"
        : lg.hasJoin ? "Join · Fan-in"
        : lg.hasBranch ? "Parallel branch"
        : `Step ${lg.level + 1}`;
      const levelBox = v_flex().id(`dep-level-${lg.level}`).gap(5).p(6).rounded(6).bg(t.surface).border(1).border_color(t.border)
        .child(h_flex().gap(6).items_center().flex_wrap()
          .child(div().flex_none().px(5).py(0.5).rounded(4).bg(t.selected).text_size(this.fs(10)).font_semibold().text_color(t.foreground).child(`L${lg.level}`))
          // No min_w(0): the role keeps its words' width, so a long badge wraps to the next line instead.
          .child(div().flex_1().text_size(this.fs(10.5)).text_color(t.muted).child(levelRole))
          .when(lg.hasCrossProject, (el) => el.child(div().flex_none().px(4).py(0.5).rounded(4).bg(t.blocked + "20")
            .text_size(this.fs(9.5)).font_semibold().text_color(t.blocked)
            .child(lg.crossProjectEdges.map((e) => `${e.fromProject} → ${e.toProject}`).join(", "))))
          .when(lg.hasJoin, (el) => el.child(div().flex_none().px(4).py(0.5).rounded(4).bg(t.ansi6 + "20")
            .text_size(this.fs(9.5)).font_semibold().text_color(t.ansi6)
            .child(`Merges ${lg.joinNodes.map((j) => j.blockers.length).join("+")} blockers`))))
        .child(lg.nodes.length > 1
          ? h_flex().gap(6).flex_wrap().children(lg.nodes.map((n) => this.renderDagNode(n, activeComp, t, false)))
          : v_flex().gap(4).children(lg.nodes.map((n) => this.renderDagNode(n, activeComp, t, false))));
      dagList.child(levelBox);
    });
    return panel.child(dagList);
  }

  /** @param {any | null} comp @param {Record<string, `#${string}`>} t */
  renderCompactInspector(comp, t) {
    const components = this.graph?.components ?? [];
    const box = v_flex().id("dep-inspector-compact").flex_none().gap(6).p(8).rounded(8).bg(t.surface).border(1).border_color(t.accent)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(this.fs(11.5)).font_semibold().text_color(t.foreground)
          .child(comp ? `Dependency Inspector · ${comp.summaryLabel} (depth ${comp.depth})` : "Dependency Inspector"))
        .when(Boolean(comp?.hasCycle), (el) => el.child(div().id("dep-cycle-badge").flex_none().px(4).py(0.5).rounded(4).bg(t.ansi1 + "24")
          .text_size(this.fs(9.5)).font_semibold().text_color(t.ansi1).child("Cycle")))
        .child(this.button("dep-inspector-close", "Close", t, (cx) => this.clearChainSelection(cx))));
    if (!comp) return box.child(div().text_size(this.fs(11)).text_color(t.muted).child(NO_CHAINS_TEXT));
    if (components.length > 1) {
      box.child(h_flex().id("dep-chain-tabs").gap(4).items_center().flex_wrap()
        .children(components.map((cComp) => {
          const on = cComp.id === comp.id;
          const targetId = cComp.roots?.[0] ?? cComp.nodeIds?.[0];
          return div().id(`dep-chain-${cComp.id}`).flex_none().px(5).py(1).rounded(4).cursor_pointer()
            .bg(on ? t.selected : t.raised).text_size(this.fs(10)).font_semibold().text_color(on ? t.foreground : t.muted)
            .on_click((_e, cx) => { if (targetId) this.focusCardFromInspector(targetId, cx); })
            .child(`${cComp.summaryLabel} (${cComp.nodeIds.length})`);
        })));
    }
    const flow = v_flex().id("dep-inspector-levels").gap(4)
      .max_h(Math.round((this.size?.height ?? 600) * COMPACT_INSPECTOR_SHARE)).min_h(0).flex_shrink(1).overflow_y_scroll();
    comp.levels.forEach((lg, idx) => {
      if (idx > 0) flow.child(div().pl(6).text_size(this.fs(10)).text_color(t.dim).child("↓"));
      flow.child(h_flex().id(`dep-level-${lg.level}`).gap(6).items_start().min_w(0)
        .child(div().flex_none().px(4).py(1).rounded(4).bg(t.selected).text_size(this.fs(9.5)).font_semibold().text_color(t.foreground).child(`L${lg.level}`))
        .child(v_flex().flex_1().min_w(0).gap(4).children(lg.nodes.map((n) => this.renderDagNode(n, comp, t, true)))));
    });
    return box.child(flow);
  }

  /** @param {any} comp */
  chainLaneFolded(comp) {
    const key = chainLaneKey(comp);
    return this.folded.has(key) && !this.query && !this.revealed.has(key);
  }

  // Unfinished dependency chains, most-blocking then deepest first, filtered by project filter and search query.
  visibleChains() {
    const q = this.query.toLowerCase();
    return (this.graph?.components ?? []).filter((comp) => {
      const activeNodes = comp.nodeIds
        .map((id) => this.graph.nodes.get(id))
        .filter((n) => n && !n.missing && n.column !== "done");
      if (!activeNodes.length) return false;
      if (this.filter && !activeNodes.some((n) => n.project === this.filter)) return false;
      if (q && !activeNodes.some((n) => searchText(n).includes(q))) return false;
      return true;
    }).sort((a, b) => b.maxBlocks - a.maxBlocks || b.depth - a.depth || b.nodeIds.length - a.nodeIds.length);
  }

  // Unfinished tasks without active dependencies, placed in the Independent drawer.
  independentCards() {
    const q = this.query.toLowerCase();
    const order = new Map(COLUMNS.map((col, i) => [col.id, i]));
    const rank = (c) => c.priority ?? Infinity;
    const list = (this.cards ?? [])
      .filter((c) => c.column !== "done" && !this.graph?.componentById?.has(c.id)
        && (!this.filter || c.project === this.filter))
      .sort((a, b) => (order.get(a.column) ?? 99) - (order.get(b.column) ?? 99) || rank(a) - rank(b));
    return q ? list.filter((c) => searchText(c).includes(q)) : list;
  }

  /** @param {string} name @param {Record<string, `#${string}`>} t @param {string} id */
  chainProjectBadge(name, t, id) {
    const color = this.colorOf(name, t);
    const tag = this.tags?.get(name) ?? name.slice(0, 3).toUpperCase();
    return h_flex().id(id).flex_none().w(30).h(16).justify_center().items_center().rounded(3).bg(color)
      .font_family(DATA_FONT).text_size(this.fs(9.5)).font_semibold().text_color("#ffffff").tooltip(name).child(tag);
  }

  /** @param {string} label @param {`#${string}`} color @param {boolean} [dashed] */
  renderChainChip(label, color, dashed = false) {
    return div().flex_none().px(6).py(1).rounded(4).border(1).border_color(color)
      .when(dashed, (e) => e.border_dashed())
      .font_family(DATA_FONT).text_size(this.fs(9)).text_color(color).child(label);
  }

  /** @param {Record<string, `#${string}`>} t */
  renderChainLegend(t) {
    const item = (label, color, dashed = false) => h_flex().gap(6).items_center()
      .child(div().w(16).h(2).border_t(1).border_color(color).when(dashed, (e) => e.border_dashed()))
      .child(div().text_size(this.fs(10.5)).text_color(t.muted).child(label));
    return h_flex().id("chain-legend").flex_none().gap(16).items_center().px(4).flex_wrap()
      .child(item("upstream", t.working))
      .child(item("selected", t.accent))
      .child(item("downstream", t.ansi6))
      .child(item("cross-project", t.dim, true))
      .child(div().font_family(DATA_FONT).text_size(this.fs(9.5)).text_color(t.dim).child("L0…Ln = dependency level"));
  }

  /** @param {any} spec @param {Map<string, string>} roles @param {boolean} dimLane @param {Record<string, `#${string}`>} t */
  renderChainPiece(spec, roles, dimLane, t) {
    const { c, o: roleO } = chainEdgeColor(spec.edge, roles, t);
    const o = dimLane ? roleO * 0.45 : roleO;
    if (spec.kind === "head") {
      return svg("mods/fm-board/arrow-head.svg").id(spec.id).absolute()
        .right(spec.right).top(spec.top).w(spec.w).h(spec.h)
        .text_color(c).when(o < 1, (el) => el.opacity(o));
    }
    const placed = div().id(spec.id).absolute()
      .when(spec.top != null, (el) => el.top(spec.top))
      .when(spec.bottom != null, (el) => el.bottom(spec.bottom))
      .border_color(c)
      .when(spec.dashed, (el) => el.border_dashed())
      .when(o < 1, (el) => el.opacity(o));
    // Herdr paints no border on a box with no room inside it, so a 0px or 1px bar would draw nothing.
    // Each bar is a 2px box whose 1px border is the line; it stays a border so cross-project lines can dash.
    if (spec.kind === "hbar") return placed.left(spec.left).right(spec.right).h(2).border_t(1);
    if (spec.kind === "vbar") return placed.left(spec.left).w(2).when(spec.h != null, (el) => el.h(spec.h)).border_l(1);
    const el = placed.left(spec.left).w(spec.w).h(spec.h);
    if (spec.cornerKind === "tr") return el.border_t(1).border_r(1).rounded_tr(CHAIN_R);
    if (spec.cornerKind === "bl") return el.border_b(1).border_l(1).rounded_bl(CHAIN_R);
    if (spec.cornerKind === "br") return el.border_b(1).border_r(1).rounded_br(CHAIN_R);
    return el.border_t(1).border_l(1).rounded_tl(CHAIN_R);
  }

  /** @param {any} node @param {Record<string, `#${string}`>} t @param {Map<string, string>} laneRoles @param {boolean} dimLane @param {number} [minH] */
  renderChainNode(node, t, laneRoles, dimLane, minH = 0) {
    const id = node.id;
    const role = laneRoles.get(id) ?? null;
    const isSelected = this.selectedCardId === id;
    const cursorSelected = !this.focusMode && this.cursorId === id && this.keys.is_focused();
    const isCurrent = Boolean(this.query) && this.currentMatch === id;
    const q = this.query.toLowerCase();
    const queryMatches = !q || (!node.missing && searchText(node).includes(q));
    const [statusLabel, statusColor] = this.nodeStatus(node, t, true);
    const roleBorder = isCurrent || isSelected || cursorSelected ? t.accent : (chainRoleColor(role, t) ?? t.border);
    const dimmed = dimLane || (Boolean(this.highlight?.dimmedIds?.has(id)) && !isCurrent) || (Boolean(q) && !queryMatches);
    const strip = (title) => (node.project && title.startsWith(`${node.project} `) ? title.slice(node.project.length + 1) : title);

    // Hairline border width stays 1px across hover and selection so cards never shift.
    const card = v_flex().id(`chain-node-${id}`).flex_1().min_w(0).when(minH > 0, (e) => e.min_h(minH)).gap(6).p(10).rounded(6)
      .bg(isSelected ? t.selected : t.background)
      .border(1).border_color(roleBorder)
      .when(dimmed, (e) => e.opacity(0.45))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(`${id}: ${node.title ?? id} · Click to highlight chain & open card detail`)
      .on_hover((hovered, cx) => this.hoverChainCard(id, hovered, cx))
      .on_click((_e, cx) => { cx.stop_propagation(); this.selectChainNode(id, cx); });

    const topRow = h_flex().h(16).gap(6).items_center().min_w(0)
      .child(node.missing
        ? div().id(`cnode-tag-${id}`).flex_none().px(4).h(16).rounded(3).border(1).border_color(t.border)
          .font_family(DATA_FONT).text_size(this.fs(9.5)).text_color(t.muted).tooltip("Not on the board").child("unknown")
        : this.chainProjectBadge(node.project || "firstmate", t, `cnode-tag-${id}`))
      .child(div().flex_1().min_w(0).font_family(DATA_FONT).text_size(this.fs(9.5)).text_color(t.dim).truncate()
        .child(chainShortId(id)))
      .when(!node.missing && node.priority !== null && node.priority !== undefined && node.column !== "done", (e) =>
        e.child(div().id(`cnode-prio-${id}`).flex_none().font_family(DATA_FONT).text_size(this.fs(9.5))
          .when(node.priority === 0, (p) => p.font_bold())
          .text_color(node.priority === 0 ? t.foreground : t.dim)
          .child(`P${node.priority}`)));

    const metaRow = h_flex().gap(6).items_center().min_w(0)
      .child(div().flex_none().w(6).h(6).rounded(3).bg(statusColor))
      .child(div().id(`cnode-status-${id}`).flex_none().text_size(this.fs(10.5)).text_color(t.muted).child(statusLabel));
    if ((node.blocksCount ?? 0) > 0 && (node.waitingIds?.length ?? 0) === 0) {
      metaRow.child(div().font_family(DATA_FONT).text_size(this.fs(10)).text_color(t.working).truncate()
        .child(`· unblocks ${node.blocksCount}`));
    } else if ((node.waitingIds?.length ?? 0) > 1) {
      metaRow.child(div().font_family(DATA_FONT).text_size(this.fs(10)).text_color(t.dim).truncate()
        .child(`· ${node.waitingIds.length} blockers`));
    }

    card.child(topRow)
      .child(div().min_w(0).text_size(this.fs(12)).font_semibold().text_color(t.foreground).child(strip(node.title ?? id)))
      .child(metaRow);

    if (node.pr && /^https:\/\//.test(node.pr)) {
      const prLabel = node.pr.replace(/^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+).*$/, "$1#$2")
        .replace("https://github.com/", "");
      card.child(div().id(`cnode-pr-${id}`).font_family(DATA_FONT).text_size(this.fs(10)).text_color(t.accent).truncate()
        .cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); this.openPr(node.pr, node, cx); })
        .child(prLabel));
    }

    if (!node.missing && this.workerLive(node)) {
      this.shownTerminals.add(node.terminal);
      const tail = (this.tails.get(node.terminal) ?? []).at(-1) || this.workerStatusLabel(node);
      card.child(div().id(`cnode-live-${id}`).px(6).py(2).rounded(2).bg(t.raised)
        .border_l(2).border_color(t.working)
        .font_family(this.monoFont).text_size(this.fs(9.5)).text_color(t.muted).truncate().child(tail));
    } else if (node.background) {
      card.child(div().px(6).py(2).rounded(2).bg(t.raised)
        .border_l(2).border_color(t.working)
        .text_size(this.fs(9.5)).font_semibold().text_color(t.foreground).truncate().child(`백그라운드 실행 중: ${node.background}`));
    }
    return card;
  }

  /** @param {any} comp @param {any} layout @param {Map<string, string>} laneRoles @param {boolean} dimLane @param {Record<string, `#${string}`>} t */
  renderChainWideGrid(comp, layout, laneRoles, dimLane, t) {
    const gutAt = (c) => layout.gutterW[c];
    const totalGutW = Array.from({ length: Math.max(0, layout.cols - 1) }, (_, c) => gutAt(c)).reduce((s, w) => s + w, 0);
    const body = v_flex().gap(0).min_w(layout.cols * CHAIN_CARD_W + totalGutW);
    const ruler = h_flex().mb(8);
    for (let c = 0; c < layout.cols; c++) {
      ruler.child(div().w(CHAIN_CARD_W).flex_none().font_family(DATA_FONT).text_size(this.fs(9))
        .text_color(t.dim).pb(4).border_b(1).border_color(t.border).child(`L${c}`));
      if (c < layout.cols - 1) ruler.child(div().w(gutAt(c)).flex_none());
    }
    body.child(ruler);

    layout.grid.forEach((row, r) => {
      const rowId = r === 0 ? `chain-spine-${comp.id}` : r === 1 ? `chain-branches-${comp.id}` : `chain-branch-row-${comp.id}-${r}`;
      const rowEl = h_flex().id(rowId).items_stretch();
      const rowMinH = layout.rowMinH[r];
      for (let c = 0; c < layout.cols; c++) {
        const id = row[c];
        const cell = v_flex().id(`chain-cell-${comp.id}-${r}-${c}`).relative().w(CHAIN_CARD_W).flex_none()
          .when(layout.rowPad[r] > 0, (e) => e.pb(layout.rowPad[r]));
        const pieces = chainCellSpecs(layout, r, c);
        if (pieces.length) cell.children(pieces.map((spec) => this.renderChainPiece(spec, laneRoles, dimLane, t)));
        if (id) {
          const node = this.graph.nodes.get(id);
          if (node) cell.child(this.renderChainNode(node, t, laneRoles, dimLane, rowMinH));
        } else if (r > 0 && c === 0) {
          const firstId = row.find(Boolean);
          const first = firstId ? this.graph.nodes.get(firstId) : null;
          const fromId = first?.waitingIds?.find((u) => layout.pos.get(u)?.r === 0)
            ?? first?.waitingIds?.find((u) => layout.pos.has(u));
          const fromNode = fromId ? this.graph.nodes.get(fromId) : null;
          if (first && fromNode) {
            const fromTag = this.tags?.get(fromNode.project) ?? (fromNode.project || "EXT").slice(0, 3).toUpperCase();
            const toTag = this.tags?.get(first.project) ?? (first.project || "EXT").slice(0, 3).toUpperCase();
            const arrow = Boolean(fromNode.project && first.project && fromNode.project !== first.project) ? "┄▸" : "→";
            cell.child(v_flex().gap(2).pt(10).pr(12).items_end()
              .child(div().font_family(DATA_FONT).text_size(this.fs(9)).text_color(t.dim).child("SIDE BRANCH"))
              .child(div().text_size(this.fs(10.5)).text_color(t.muted).child(`forks from ${chainShortId(fromId)}`))
              .child(div().font_family(DATA_FONT).text_size(this.fs(9.5)).text_color(t.dim).child(`${fromTag} ${arrow} ${toTag}`)));
          }
        }
        rowEl.child(cell);
        if (c < layout.cols - 1) {
          const pieces = chainGutterSpecs(layout, r, c);
          rowEl.child(div().id(`chain-gutter-${comp.id}-${r}-${c}`).relative().w(gutAt(c)).flex_none()
            .children(pieces.map((spec) => this.renderChainPiece(spec, laneRoles, dimLane, t))));
        }
      }
      body.child(rowEl);
    });
    return div().id(`chain-grid-${comp.id}`).w_full().min_w(0).overflow_x_scroll().child(body);
  }

  /** @param {any} comp @param {any} layout @param {Map<string, string>} laneRoles @param {boolean} dimLane @param {Record<string, `#${string}`>} t */
  renderChainStepper(comp, layout, laneRoles, dimLane, t) {
    const RAIL = 40, RX = 28;
    const spineSet = new Set(layout.spineIds);
    const segColor = (i) => chainEdgeColor({ u: layout.spineIds[i], v: layout.spineIds[i + 1] }, laneRoles, t);
    const isCross = (node) => (node.waitingIds ?? []).some((u) => {
      const up = this.graph.nodes.get(u);
      return Boolean(node.project && up?.project && node.project !== up.project);
    }) || (node.blockingIds ?? []).some((d) => {
      const dn = this.graph.nodes.get(d);
      return Boolean(node.project && dn?.project && node.project !== dn.project);
    });

    const subrows = [];
    for (const step of layout.steps) {
      step.nodes.forEach((n, k) => subrows.push({ n, lv: step.level, first: k === 0, spine: spineSet.has(n.id) }));
    }

    const stepper = v_flex().id(`chain-stepper-${comp.id}`).gap(0);
    const byLevel = new Map();
    subrows.forEach((s, i) => {
      const isLastRow = i === subrows.length - 1;
      const rail = div().relative().w(RAIL).flex_none().when(dimLane, (e) => e.opacity(0.45));
      if (s.first) {
        rail.child(div().absolute().left(0).top(12).font_family(DATA_FONT).text_size(this.fs(9))
          .text_color(t.dim).child(`L${s.lv}`));
      }
      if (s.spine) {
        const pos = layout.spineIds.indexOf(s.n.id);
        if (pos > 0) {
          const { c, o } = segColor(pos - 1);
          rail.child(div().absolute().left(RX).top(0).h(14).w(2).border_l(1).border_color(c).when(o < 1, (e) => e.opacity(o)));
        }
        if (pos < layout.spineIds.length - 1 || !isLastRow) {
          const { c, o } = pos < layout.spineIds.length - 1 ? segColor(pos) : { c: t.dim, o: 1 };
          rail.child(div().absolute().left(RX).top(22).bottom(0).w(2).border_l(1).border_color(c).when(o < 1, (e) => e.opacity(o)));
        }
        const [, statusColor] = this.nodeStatus(s.n, t, true);
        const rc = chainRoleColor(laneRoles?.get(s.n.id) ?? null, t);
        rail.child(div().absolute().left(RX - 4).top(14).w(9).h(9).rounded(5)
          .border(1.5).border_color(rc ?? statusColor).bg(rc ?? t.surface));
      } else {
        const nextSpineIdx = layout.spineIds.findIndex((id) => (layout.levelOf.get(id) ?? 0) > s.lv);
        const { c: railC, o: railO } = nextSpineIdx > 0 ? segColor(nextSpineIdx - 1) : { c: t.dim, o: 1 };
        if (!isLastRow) {
          rail.child(div().absolute().left(RX).top(0).bottom(0).w(2).border_l(1).border_color(railC).when(railO < 1, (e) => e.opacity(railO)));
        } else {
          rail.child(div().absolute().left(RX).top(0).h(18).w(2).border_l(1).border_color(railC).when(railO < 1, (e) => e.opacity(railO)));
        }
        const cross = isCross(s.n);
        const rc = chainRoleColor(laneRoles?.get(s.n.id) ?? null, t) ?? t.dim;
        rail.child(div().absolute().top(18).left(RX).right(0).h(2).border_t(1).border_color(rc)
          .when(cross, (e) => e.border_dashed()));
      }

      const content = h_flex().flex_1().min_w(0).when(!isLastRow, (e) => e.pb(8));
      if (!s.spine) {
        const j = chainJoint(18);
        const cross = isCross(s.n);
        const rc = chainRoleColor(laneRoles?.get(s.n.id) ?? null, t) ?? t.dim;
        content.child(div().id(`chain-stepper-conn-${s.n.id}`).relative().w(20).flex_none().when(dimLane, (e) => e.opacity(0.45))
          .child(div().id(`chain-stepper-edge-${s.n.id}-line`).absolute().top(j.lineTop).left(0).right(j.headW).h(2)
            .border_t(1).border_color(rc).when(cross, (e) => e.border_dashed()))
          .child(svg("mods/fm-board/arrow-head.svg").id(`chain-stepper-edge-${s.n.id}-head`).absolute()
            .right(0).top(j.headTop).w(j.headW).h(j.headH).text_color(rc)));
      }
      const cd = this.renderChainNode(s.n, t, laneRoles, dimLane);
      if (!s.spine) {
        const forks = (s.n.waitingIds ?? []).filter((u) => spineSet.has(u));
        const joins = (s.n.blockingIds ?? []).filter((d) => spineSet.has(d));
        const note = [];
        if (forks.length) note.push(`forks from ${forks.map(chainShortId).join(", ")}`);
        if (joins.length) note.push(`joins ${joins.map(chainShortId).join(", ")} ↓`);
        if (note.length) cd.child(div().font_family(DATA_FONT).text_size(this.fs(9.5)).text_color(t.dim).child(note.join(" · ")));
      }
      content.child(cd);
      const rowEl = h_flex().items_stretch().child(rail).child(content);
      if (!byLevel.has(s.lv)) byLevel.set(s.lv, []);
      byLevel.get(s.lv).push(rowEl);
    });
    for (const [lv, rows] of byLevel) {
      stepper.child(v_flex().id(`chain-step-${comp.id}-${lv}`).gap(0).children(rows));
    }
    return stepper;
  }

  /** @param {any} comp @param {number} idx @param {Record<string, `#${string}`>} t @param {boolean} stacked */
  renderChainLane(comp, idx, t, stacked) {
    const laneKey = chainLaneKey(comp);
    const folded = this.chainLaneFolded(comp);
    const realNodes = comp.nodeIds.map((id) => this.graph.nodes.get(id)).filter((n) => n && !n.missing && n.column !== "done");
    const projects = [...new Set(realNodes.map((n) => n.project || "firstmate"))];
    const workingCount = realNodes.filter((n) => n.column === "working").length;
    const isTopChain = idx === 0;

    const header = h_flex().id(`head-chain-${comp.id}`).gap(8).items_center().min_w(0)
      .cursor_pointer().hover((s) => s.opacity(0.8))
      .on_click((_e, cx) => this.toggleFold(laneKey, cx))
      .child(div().flex_none().text_size(this.fs(10)).text_color(t.dim).child(folded ? "▸" : "▾"))
      .child(div().flex_none().font_family(DATA_FONT).text_size(this.fs(10)).text_color(t.dim).child(`CHAIN ${idx + 1}`))
      .children(projects.slice(0, 3).map((p, pIdx) => this.chainProjectBadge(p, t, `lane-tag-${comp.id}-${pIdx}`)))
      .child(div().flex_1().min_w(0).truncate().text_size(this.fs(12)).font_semibold().text_color(t.foreground).child(comp.summaryLabel))
      .when(Boolean(comp.hasCycle), (e) => e.child(this.renderChainChip("CYCLE", t.ansi1)))
      .when(isTopChain && comp.depth > 1, (e) => e.child(this.renderChainChip("CRITICAL PATH", t.working)))
      .when(!stacked && (comp.crossProjectEdges?.length ?? 0) > 0, (e) => e.child(this.renderChainChip("CROSS-PROJECT", t.muted, true)))
      .child(div().flex_none().font_family(DATA_FONT).text_size(this.fs(10)).text_color(t.dim)
        .child(stacked ? `${comp.depth} steps` : `${comp.depth} steps · ${realNodes.length} tasks${workingCount ? ` · ${workingCount} working` : ""}`));

    const lane = v_flex().id(`chain-lane-${comp.id}`).flex_none().gap(12).p(12).rounded(8).bg(t.surface)
      .border(1).border_color(t.border).child(header);
    if (folded) return lane;

    const layout = placeChainLane(comp, this.graph.nodes);
    const laneRoles = this.highlight?.focusComponent?.id === comp.id ? this.highlight.roles : new Map();
    const dimLane = Boolean(this.highlight?.selectedComponent) && this.highlight.selectedComponent.id !== comp.id;

    if (stacked) {
      lane.child(this.renderChainStepper(comp, layout, laneRoles, dimLane, t));
    } else if (layout.cols > 0) {
      lane.child(this.renderChainWideGrid(comp, layout, laneRoles, dimLane, t));
    }

    if (this.selectedCardId && comp.nodeIds.includes(this.selectedCardId)) {
      const selectedCard = (this.cards ?? []).find((c) => c.id === this.selectedCardId);
      const body = selectedCard ? this.card(selectedCard, t, false)
        : div().text_size(this.fs(11)).text_color(t.muted).child("External blocker not in the current backlog snapshot.");
      lane.child(this.taskDetail("chain-detail", this.selectedCardId, body, t, (cx) => this.clearChainSelection(cx))
        .pt(10).border_t(1).border_color(t.border));
    }
    return lane;
  }

  /** @param {any[]} cards @param {Record<string, `#${string}`>} t @param {boolean} stacked */
  renderIndependentDrawer(cards, t, stacked) {
    const open = this.independentOpen || (Boolean(this.query) && cards.length > 0);
    const counts = [
      ["working", cards.filter((c) => c.column === "working").length],
      ["ready", cards.filter((c) => c.column === "queued").length],
      ["held", cards.filter((c) => c.column === "held").length],
      ["paused", cards.filter((c) => c.column === "paused").length],
      ["blocked", cards.filter((c) => c.column === "blocked").length],
      ["parked", cards.filter((c) => c.column === "parked").length],
      ["review", cards.filter((c) => c.column === "review").length],
      ["todo", cards.filter((c) => c.column === "todo").length],
    ].filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`).join(" · ");

    const header = h_flex().id("head-independent").gap(8).items_center()
      .cursor_pointer().hover((s) => s.opacity(0.8))
      .on_click((_e, cx) => this.toggleIndependent(cx))
      .child(div().flex_none().text_size(this.fs(10)).text_color(t.dim).child(open ? "▾" : "▸"))
      .child(div().flex_none().font_family(DATA_FONT).text_size(this.fs(10)).text_color(t.dim).child("INDEPENDENT"))
      .child(div().flex_1().min_w(0).text_size(this.fs(12)).font_semibold().text_color(t.foreground)
        .child(`${cards.length} ${cards.length === 1 ? "task" : "tasks"} without dependencies`))
      .child(div().font_family(DATA_FONT).text_size(this.fs(10)).text_color(t.dim).truncate()
        .child(counts || "No independent tasks"));

    const drawer = v_flex().id("independent-drawer").flex_none().gap(10).px(12).py(10).rounded(8).bg(t.surface)
      .border(1).border_color(t.border).child(header);
    if (!open) return drawer;
    if (!cards.length) {
      return drawer.child(div().px(4).text_size(this.fs(11)).text_color(t.muted).child("No independent tasks in the current view."));
    }
    const list = stacked
      ? v_flex().id("independent-list").gap(6).children(cards.map((c) => this.card(c, t, false)))
      : h_flex().id("independent-list").flex_wrap().gap(6).items_start()
          .children(cards.map((c) => div().w(260).min_w(220).child(this.card(c, t, false))));
    drawer.child(list);
    const selected = this.selectedCardId && cards.find((c) => c.id === this.selectedCardId);
    if (selected) {
      drawer.child(this.taskDetail("chain-detail", selected.id, this.card(selected, t, false), t, (cx) => this.clearChainSelection(cx))
        .pt(10).border_t(1).border_color(t.border));
    }
    return drawer;
  }

  /** @param {Record<string, `#${string}`>} t @param {boolean} stacked */
  renderChainsView(t, stacked) {
    const chains = this.visibleChains();
    const independent = this.independentCards();
    const wrap = v_flex().id("chains-board").flex_1().min_h(0).gap(12).overflow_y_scrollbar().track_scroll(this.chainsScroll);
    if (chains.length) wrap.child(this.renderChainLegend(t));
    if (!chains.length) {
      if (this.query && !independent.length) {
        return wrap.child(div().p(12).text_size(this.fs(11.5)).text_color(t.muted).child("No matching chains or tasks."));
      }
      if (!this.query) {
        wrap.child(div().p(10).rounded(8).bg(t.surface).border(1).border_color(t.border)
          .text_size(this.fs(11.5)).text_color(t.muted).child(NO_CHAINS_TEXT));
      }
    } else {
      wrap.children(chains.map((comp, idx) => this.renderChainLane(comp, idx, t, stacked)));
    }
    if (!this.query || independent.length > 0) {
      wrap.child(this.renderIndependentDrawer(independent, t, stacked));
    }
    return wrap;
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

  // A PR link shows the PR in the layout's PR panel when the herdr-pr-viewer mod is installed in
  // this Herdr home, following that mod's panel contract: the request goes in a shared value whose
  // `at` makes each click new, then the panel is selected and shown. Without the mod or without
  // that panel in the layout, the browser opens the link.
  // The viewer shows the card's task and its project tag in the tag's own color.
  /** @param {string} url @param {{ id: string, project?: string }} c @param {import("gpui-kit").Context} cx */
  openPr(url, c, cx) {
    const project = c.project || "firstmate";
    const badge = { text: this.tags?.get(project) ?? project.slice(0, 3).toUpperCase(), color: this.colorOf(project, theme()) };
    const task = c.project ? `${c.id} · ${c.project}` : c.id;
    cx.spawn(async () => {
      let installed = false;
      try { installed = (await readTextFile(`${appHome()}/mods/${PR_VIEWER_MOD}/mod.json`)) != null; } catch {}
      if (!installed || !findNode(layout(), PR_PANEL)) { await exec("open", [url]); return; }
      setShared(PR_SHOW_KEY, { url, task, badge, at: Date.now() });
      run("layout.select", { stack: "panel-body", child: PR_PANEL });
      run("layout.show", { id: "panel" });
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

  // One box per topic: the question and its options once, then every task it decides.
  group(topic, cards, t) {
    const foldId = `group:${topic}`, folded = this.folded.has(foldId) && !this.query && !this.revealed.has(foldId);
    const decision = sharedDecision(cards);
    const ids = cards.map((c) => c.id), question = decision.question || topic;
    const boxDimmed = this.focusMode && !cards.some(needsCaptain);
    // A hairline, not the accent: accent marks hover, selection, and the search match only.
    const box = v_flex().id(`group-${topic}`).gap(6).p(8).rounded(4).bg(t.raised).border(1).border_color(t.border)
      .when(boxDimmed, (e) => e.opacity(FOCUS_DIM))
      .child(this.foldRow(foldId, t, folded, question,
        div().flex_none().text_size(this.fs(11)).text_color(t.dim).child(String(cards.length)))
        .child(this.askButton(foldId, ids, question, t)));
    if (folded) return box;
    this.decisionLines(box, decision, t, `group:${topic}`, ids, cards.some((c) => c.column === "held"));
    return box.children(cards.map((c) => this.card(c, t, true, boxDimmed)));
  }

  // A column's entries in drawing order: a card, or a topic group at its first card's place.
  // Only holds share a topic box; a card lists its open decisions itself, each with its own key.
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

  // Matching card ids in the order the active board view draws them.
  matchIds() {
    if (this.viewMode === "chains") {
      const q = this.query.toLowerCase();
      const stacked = (this.size?.width ?? Infinity) < STACK_BELOW_PX;
      const ids = [];
      for (const comp of this.visibleChains()) {
        const layout = placeChainLane(comp, this.graph.nodes);
        const drawn = stacked
          ? layout.steps.flatMap((step) => step.nodes)
          : layout.grid.flat().map((id) => (id ? this.graph.nodes.get(id) : null)).filter(Boolean);
        for (const n of drawn) {
          if (!n.missing && n.column !== "done" && searchText(n).includes(q)) ids.push(n.id);
        }
      }
      for (const c of this.independentCards()) ids.push(c.id);
      return ids;
    }
    return this.shownColumns().flatMap((col) => this.columnCards(col.id)).map((c) => c.id);
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

  // The top of the task board: the Kanban | Chains view toggle, search field, find icon,
  // match count, and (in Kanban) the Dependency Inspector toggle.
  searchRow(t, matches) {
    const count = !this.query ? null : matches.length ? `${this.matchAt % matches.length + 1}/${matches.length}` : "No matches";
    const chainCount = this.graph?.components?.length ?? 0;
    const toggleLabel = chainCount > 0 ? `Inspector (${chainCount})` : "Inspector";
    const chainsLabel = chainCount > 0 ? `Chains (${chainCount})` : "Chains";
    const modeTab = (id, mode, label) => {
      const on = this.viewMode === mode;
      return div().id(id).flex_none().px(7).py(2.5).rounded(4).cursor_pointer()
        .when(on, (e) => e.bg(t.background))
        .text_size(this.fs(11)).font_semibold().text_color(on ? t.foreground : t.muted)
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => this.setViewMode(mode, cx))
        .child(label);
    };
    return h_flex().id("kanban-search").flex_none().gap(4).items_center().flex_wrap()
      .on_key_down((e, cx) => {
        if (e.key === "escape" && (this.query || this.search.value())) { this.clearSearch(cx); cx.stop_propagation(); }
        else if (e.key === "escape" && (this.inspectorOpen || this.selectedCardId)) { this.clearChainSelection(cx); cx.stop_propagation(); }
      })
      .child(h_flex().id("view-mode-toggle").flex_none().gap(2).p(2).rounded(6).bg(t.surface).border(1).border_color(t.border)
        .child(modeTab("view-mode-kanban", "kanban", "Kanban"))
        .child(modeTab("view-mode-chains", "chains", chainsLabel)))
      .child(div().flex_1().min_w(120).child(this.field(this.search, t)))
      .child(div().id("search-find").flex_none().p(5).rounded(5).cursor_pointer().bg(t.raised)
        .hover((s) => s.bg(t.hover)).tooltip("Find next (Enter) · Esc clears")
        .on_click((_e, cx) => this.findNext(cx))
        .child(svg("mods/workspace-chrome/search.svg").size(this.fs(14)).text_color(t.muted)))
      .when(count !== null, (el) =>
        el.child(div().flex_none().text_size(this.fs(11)).text_color(matches.length ? t.muted : t.blocked).child(count)))
      .when(this.viewMode === "kanban", (el) =>
        el.child(div().id("dep-inspector-toggle").flex_none().px(7).py(3.5).rounded(5).cursor_pointer()
          .border(1).border_color(this.inspectorOpen ? t.accent : t.border)
          .bg(this.inspectorOpen ? t.selected : t.raised)
          .text_size(this.fs(11)).font_semibold().text_color(this.inspectorOpen ? t.foreground : t.muted)
          .hover((s) => s.opacity(0.85))
          .tooltip(this.inspectorOpen ? "Close Dependency Inspector (Esc)" : "Open Dependency Inspector")
          .on_click((_e, cx) => this.toggleInspector(cx))
          .child(toggleLabel))
          .child(h_flex().id("focus-toggle").flex_none().gap(6).items_center().px(7).py(3.5).rounded(3).cursor_pointer()
            .border(1).border_color(this.focusMode ? t.accent : t.border).bg(this.focusMode ? t.accent : t.raised)
            .text_size(this.fs(11)).font_semibold().text_color(this.focusMode ? t.accent_foreground : t.muted)
            .hover((s) => s.opacity(0.85))
            .tooltip(this.focusMode ? "Leave Focus (F or Esc)" : "Focus: dim everything but your calls; j/k move between them (F)")
            .on_click((_e, cx) => this.toggleFocus(cx))
            .child(div().child("Focus"))
            .child(this.keyCap("F", t, this.focusMode))));
  }

  // A key name drawn as a small outlined cap, for keyboard hints.
  /** @param {string} key @param {Record<string, string>} t @param {boolean} [onAccent] */
  keyCap(key, t, onAccent = false) {
    return div().flex_none().px(4).rounded(3).border(1).border_color(onAccent ? t.accent_foreground : t.input)
      .font_family(DATA_FONT).text_size(this.fs(10)).text_color(onAccent ? t.accent_foreground : t.muted).child(key);
  }

  // The keys Focus answers to, under the search row while it is on.
  /** @param {Record<string, string>} t */
  focusHint(t) {
    const hint = (keys, label) => h_flex().flex_none().gap(4).items_center()
      .children(keys.map((k) => this.keyCap(k, t)))
      .child(div().text_size(this.fs(11)).text_color(t.muted).child(label));
    return h_flex().id("focus-hint").flex_none().gap(12).items_center().flex_wrap()
      .child(hint(["j", "k"], "move between your calls"))
      .child(hint(["⏎"], "answer with the recommended option"))
      .child(hint(["o"], "open worker"))
      .child(hint(["Esc"], "leave Focus"));
  }

  cardsIn(id) {
    const all = (this.cards ?? []).filter((c) => c.column === id && (!this.filter || c.project === this.filter));
    // Highest priority first; equal or unset priorities keep backlog order (sort is stable).
    const rank = (c) => c.priority ?? Infinity;
    const shown = id === "done" ? all.slice(-DONE_LIMIT).reverse() : all.sort((a, b) => rank(a) - rank(b));
    const q = this.query.toLowerCase();
    return q ? shown.filter((c) => searchText(c).includes(q)) : shown;
  }

  // A Held group's heading: ruled like the column header, so the groups stand apart from the cards
  // between them, but quieter than that header: a hairline, smaller muted text.
  holdHeading(s, t) {
    return this.ledgerHead(h_flex().gap(6).items_center(), t)
      .child(div().min_w(0).truncate().text_size(this.fs(10.5)).font_semibold().text_color(t.muted).child(s.title))
      .child(this.count(s.cards.length, t));
  }

  // Ledger columns are open lanes on the frame, split by hairlines; a rule in the column's status
  // color under its heading names it instead of a filled strip. first is the leftmost lane.
  column(col, t, stacked, first) {
    const cards = this.cardsIn(col.id);
    // A collapsed column that holds a match opens while the search lasts.
    const collapsed = this.collapsed.has(col.id) && !(this.query && cards.length) && !this.revealed.has(col.id);
    // In Focus a lane without a captain's call steps back with its cards.
    const dimHead = this.focusMode && !cards.some(needsCaptain);
    const header = h_flex().id(`head-${col.id}`).gap(6).items_center().cursor_pointer()
      .hover((s) => s.opacity(0.75))
      .when(dimHead, (e) => e.opacity(FOCUS_DIM))
      .on_click((_e, cx) => { if (!this.query) this.toggle(col.id, cx); })
      .child(div().text_size(this.fs(10)).text_color(t.dim).child(collapsed ? "▸" : "▾"));
    const lane = (el) => (stacked || first ? el : el.border_l(1).border_color(t.border));
    if (collapsed && !stacked) {
      return lane(v_flex().id(`col-${col.id}`).w(36).h_full().py(4).px(8).gap(6).items_center())
        .child(header.child(div().w(8).h(8).rounded(4).bg(t[col.color])))
        .child(div().font_family(DATA_FONT).text_size(this.fs(11)).text_color(t.dim).child(String(cards.length)))
        .child(v_flex().items_center().children([...col.title].map((letter) =>
          div().text_size(this.fs(11)).font_semibold().text_color(t.foreground).child(letter))));
    }
    this.ledgerHead(header, t, t[col.color], 2)
      .child(div().text_size(this.fs(11.5)).font_semibold().text_color(t.foreground).child(col.title))
      .child(this.count(cards.length, t));
    const el = lane(v_flex().id(`col-${col.id}`).min_w(0).gap(8).py(4).px(first && !stacked ? 2 : 8)).child(header);
    if (!stacked) el.flex_1().h_full();
    else el.flex_none(); // stacked columns keep their height; the board scrolls as one list
    if (collapsed) return el;
    const list = v_flex().id(`list-${col.id}`).gap(6);
    for (const [i, s] of this.sections(col.id).entries()) {
      if (!s.title) { list.children(this.items(s.cards, t)); continue; }
      // Each group is its own element, so a topic box drawn in two groups keeps a distinct id.
      // Extra room above every group after the first, so a heading belongs to the cards below it.
      list.child(v_flex().id(`hold-${s.id}`).gap(6).when(i > 0, (e) => e.mt(6))
        .child(this.holdHeading(s, t))
        .children(this.items(s.cards, t)));
    }
    return el.child(stacked ? list : list.flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.colScrolls.get(col.id)));
  }

  // The same tag on project rows and cards; hovering shows the full project name.
  projectBadge(name, t, id) {
    const color = this.colorOf(name, t);
    const tag = this.tags?.get(name) ?? name.slice(0, 3).toUpperCase();
    // A fixed width (scaled with the text) keeps every tag the same size, whatever its letters.
    return h_flex().id(id).flex_none().w(this.fs(38)).justify_center().py(1).rounded(3).bg(color)
      .font_family(DATA_FONT).text_size(this.fs(11)).font_semibold().text_color("#ffffff").tooltip(name).child(tag);
  }

  badge(label, color) {
    return div().flex_none().px(6).py(1).rounded(3).border(1).border_color(color).font_family(DATA_FONT).text_size(this.fs(11)).text_color(color).child(label);
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
    const refreshNow = (e) => e.cursor_pointer().hover((s) => s.opacity(0.75))
      .tooltip("Click to refresh now")
      .on_click((_e, cx) => this.refresh(cx, { force: true }));
    if (this.error && !this.loading) {
      right.child(refreshNow(h_flex().id("refresh").gap(6).items_center().min_w(0)
        .child(text(this.error)).child(this.badge("Update failed", t.ansi1))));
    } else if (!this.cards) right.child(text("Loading"));
    else {
      if (this.notice) right.child(text(`${this.notice} ·`));
      const updated = div().id("refresh").min_w(0).text_size(this.fs(11)).text_color(t.dim).truncate()
        .child(this.loading ? "Refreshing…" : `Updated ${koreaTime(this.generated)}`)
        .when(!this.loading, refreshNow);
      right.child(updated);
      if (this.ready !== null) right.child(this.ready ? this.badge("Receiving", t.ansi2) : this.badge("Not receiving", t.working));
    }
    // The whole status group sits at the strip's right end, apart from the tabs, so a red
    // "No watcher" never reads as another tab.
    return h_flex().id("board-status").flex_none().gap(10).items_center().justify_end().min_w(0)
      .child(h_flex().flex_shrink(1).min_w(0).gap(10).items_center().overflow_hidden().children(this.watcherChips(t)))
      .child(right);
  }

  // Compact monitoring list of registered checks (state/*.check.sh) and the home-wide last sweep time.
  checksBody(t) {
    const list = this.checks ?? [];
    const sweep = this.checks === null ? "Loading…"
      : this.checksFailed ? "Could not read"
      : (localTime(this.lastCheckSweep) || "Not recorded");
    const wrap = v_flex().id("checks-section").gap(4)
      .child(h_flex().gap(8).items_center().justify_between()
        .child(div().flex_none().text_size(this.fs(11.5)).font_semibold().text_color(t.foreground).child("Registered checks"))
        .child(div().id("checks-last-sweep").min_w(0).truncate().text_size(this.fs(11)).text_color(t.dim)
          .tooltip("Home-wide watcher check-sweep time from state/.last-check; Firstmate does not record per-check running state, last run, or result")
          .child(`Last sweep (all checks): ${sweep}`)));
    const rows = v_flex().id("checks-list").gap(2).max_h(110).min_h(0).flex_shrink(1).overflow_y_scroll();
    if (this.checks === null) {
      rows.child(div().px(6).text_size(this.fs(11)).text_color(t.dim).child("Loading registered checks…"));
    } else if (this.checksFailed) {
      rows.child(div().px(6).text_size(this.fs(11)).text_color(t.dim).child("Could not read registered checks"));
    } else if (!list.length) {
      rows.child(div().px(6).text_size(this.fs(11)).text_color(t.dim).child("No registered checks"));
    } else {
      rows.children(list.map((c) => h_flex().id(`check-${c.name}`).gap(6).px(6).py(1).items_center().min_w(0)
        .tooltip(`Registered check file: state/${c.name}.check.sh`)
        .child(div().flex_none().w(5).h(5).rounded(2.5).bg(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(this.fs(11)).text_color(t.foreground).child(c.name))));
    }
    return wrap.child(rows);
  }

  // Below the board: one strip of tabs (Commands, Projects, Checks) with the supervision status on
  // its right, and the chosen tab's content under it. Clicking the open tab folds the content away.
  // The Projects tab carries the count of Board requests firstmate has not handled yet, such as
  // Memos, so they stay in view whichever tab is open.
  /** @param {Record<string, string>} t */
  bottomGroup(t) {
    const folded = this.collapsed.has(BOTTOM);
    const tab = (id, label, ...extra) => {
      const on = this.bottomTab === id;
      return h_flex().id(`bottom-tab-${id}`).flex_none().gap(6).items_center().px(2).pt(2).pb(6)
        .border_b(2).border_color(on && !folded ? t.foreground : t.background)
        .cursor_pointer().hover((s) => s.opacity(0.75))
        .tooltip(on ? (folded ? "Show this tab" : "Fold this tab away") : `Show ${label}`)
        .on_click((_e, cx) => this.pickBottomTab(id, cx))
        .child(div().text_size(this.fs(12)).font_semibold().text_color(on ? t.foreground : t.muted).child(label))
        .children(extra.filter(Boolean));
    };
    const pending = this.requests.length;
    const strip = h_flex().id("bottom-tabs").gap(16).items_end().flex_wrap()
      .when(!folded, (e) => e.border_b(1).border_color(t.border))
      .child(tab("commands", "Commands"))
      .child(tab("projects", "Projects", this.count(this.projects.length, t), pending > 0
        ? div().id("projects-pending").flex_none().px(6).rounded(3).border(1).border_color(t.working)
          .font_family(DATA_FONT).font_weight(500).text_size(this.fs(10)).text_color(t.working)
          .tooltip("Board requests and Memos firstmate has not handled yet").child(`${pending} pending`)
        : null))
      .child(tab("checks", "Checks", this.checks !== null && !this.checksFailed ? this.count(this.checks.length, t) : null))
      .child(div().flex_1().min_w(0).pb(6).child(this.footer(t)));
    const el = this.frame(v_flex().id("bottom-group").flex_none().gap(8), t).child(strip);
    if (folded) return el;
    return el.child(this.bottomTab === "projects" ? this.projectsBody(t)
      : this.bottomTab === "checks" ? this.checksBody(t) : this.commandsBody(t));
  }

  // Shows another tab, or folds or unfolds the one already shown; both are remembered.
  /** @param {string} id @param {import("gpui-kit").Context} cx */
  pickBottomTab(id, cx) {
    if (this.bottomTab === id) { this.toggle(BOTTOM, cx); return; }
    this.bottomTab = id;
    try { localStorage.setItem(BOTTOM_TAB_KEY, id); } catch {}
    if (this.collapsed.has(BOTTOM)) this.toggle(BOTTOM, cx); else cx.notify();
  }

  panelFocused() {
    return this.keys.is_focused() || this.focusedInputs.size > 0;
  }

  // Matches the terminal pane's 1 px rounded perimeter frame so focus changes border color without layout shift.
  panelFrame(el, t) {
    const focused = this.panelFocused();
    return v_flex().id("panel-frame").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.canvas)
      .border(1).border_color(focused ? t.accent : t.border)
      // gpui-kit offers no blur event on a FocusHandle; capture-phase mouse_down_out fires before
      // the clicked pane moves focus, so defer one tick to redraw with the updated panelFocused().
      .when(focused, (frame) => frame.on_mouse_down_out((_e, cx) => {
        cx.timer.after(0, (later) => later.notify());
      }))
      .child(el);
  }

  render(_cx) {
    this.readFontScale(this.size?.width);
    const names = this.projectNames();
    this.tags = abbreviations(["firstmate", ...names]);
    this.updateColors(names);
    const t = theme();
    if (!home()) return this.panelFrame(v_flex().id("home-required").size_full().bg(t.canvas).p(16)
      .child(v_flex().gap(8).p(16).rounded(8).bg(t.surface).border(1).border_color(t.border)
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child("Firstmate home required"))
        .child(div().text_size(13).text_color(t.muted).child("Set the home prop on this mod in your layout to the path of your firstmate home."))), t);
    // terminals() is live data, so a worker starting or ending redraws the cards.
    this.liveWorkers = new Map(terminals().filter((x) => x.state === "live")
      .map((x) => [x.address, { task: x.labels?.["firstmate.task"], status: x.status, pid: x.pid }]));
    // A paused card whose worker still runs a job is drawn in Working until that job ends.
    for (const c of this.cards ?? []) {
      c.background = this.backgroundOf(c);
      c.column = c.background && c.ownColumn === "paused" ? "working" : c.ownColumn;
    }
    this.monoFont = String(settings()?.font_family ?? "JetBrains Mono");
    this.graph = dependencyGraph(this.cards ?? []);
    if (this.pendingInitialCursor && this.cards) {
      this.pendingInitialCursor = false;
      if (!this.focusMode) this.placeCursor();
    }
    this.highlight = chainHighlight(this.graph, this.selectedCardId, this.hoveredCardId);
    // Hover may only change colors (`highlight`); anything that changes size or position (border
    // widths, role pills, the inspector's chain) follows the selection only (`pinned`). Otherwise a
    // hovered element shifts under a still pointer and GPUI's paint-time hover test loops every frame.
    this.pinned = chainHighlight(this.graph, this.selectedCardId, null);
    const activeComp = this.pinned?.selectedComponent ?? (this.inspectorOpen ? (this.graph.components[0] ?? null) : null);
    // The cards drawn below record which worker screens are worth reading.
    this.shownTerminals = new Set();
    const boardWidth = this.size?.width ?? Infinity;
    const stacked = boardWidth < STACK_BELOW_PX;
    const modWidth = boardWidth + (this.splitWasOpen ? (this.rightSplitWidth || this.inspectorWidth(boardWidth)) : 0);
    // The inspector takes the split only if the Board half it leaves still draws unstacked
    // columns; otherwise it is the compact card. Judged on the whole width, so dragging the
    // divider keeps the split and the Board half just stacks.
    const narrowMod = modWidth - this.inspectorWidth(modWidth) < STACK_BELOW_PX;
    const isChains = this.viewMode === "chains";
    const inspectorShown = !isChains && this.inspectorOpen;
    const detailCard = !isChains && !this.focusMode && this.detailCardId
      ? ((this.cards ?? []).find((c) => c.id === this.detailCardId) ?? null)
      : null;
    const matches = this.query ? this.matchIds() : [];
    this.currentMatch = matches.length ? matches[this.matchAt % matches.length] : null;
    const board = isChains
      ? this.renderChainsView(t, stacked)
      : (stacked
        ? v_flex().id("board").overflow_y_scrollbar().track_scroll(this.boardScroll)
        : h_flex().id("board")).flex_1().min_h(0).gap(stacked ? 8 : 0)
          .children(this.shownColumns().map((c, i) => this.column(c, t, stacked, i === 0)));
    const root = v_flex().id("root").size_full().bg(t.canvas).px(8).pt(2.5).pb(3).gap(6)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .track_focus(this.keys)
      .on_key_down((e, cx) => {
        if (this.focusKey(e, cx)) cx.stop_propagation();
        else if (e.key === "escape" && (this.inspectorOpen || this.selectedCardId)) { this.clearChainSelection(cx); cx.stop_propagation(); }
        else if (e.key === "escape" && this.pointedId) { this.pointedId = null; cx.notify(); cx.stop_propagation(); }
      });
    // Focus keeps only the captain's calls at full strength; the rest of the Board steps back.
    const back = (el) => el.when(this.focusMode, (e) => e.opacity(FOCUS_DIM));
    if (this.cards) {
      const holds = this.waitingHolds();
      root.child(this.todayStrip(t, holds, stacked));
      const next = this.nextMove(t, holds);
      if (next) root.child(next);
    }
    if (this.filter) {
      root.child(h_flex().gap(6).items_center()
        .child(div().text_size(this.fs(11)).text_color(t.muted).child(`Filter: ${this.filter}`))
        .child(this.button("filter-clear", "Clear", t, (cx) => { this.filter = null; cx.notify(); })));
    }
    root.child(this.frame(v_flex().flex_1().min_h(0).overflow_hidden().gap(6), t)
      .child(this.searchRow(t, matches))
      .when(this.focusMode && !isChains, (e) => e.child(this.focusHint(t)))
      .when(narrowMod && inspectorShown, (e) => e.child(this.renderCompactInspector(activeComp, t)))
      .when(Boolean(detailCard), (e) => e.child(this.taskDetail("card-detail", detailCard.id,
        div().id("card-detail-scroll").max_h(Math.max(72, Math.round((this.size?.height ?? 600) * 0.25))).overflow_y_scroll()
          .child(this.card(detailCard, t, false)),
        t, (cx) => { this.detailCardId = null; cx.notify(); }).flex_none()))
      .child(board))
      .child(back(this.bottomGroup(t)));
    if (this.viewer.root) {
      this.splitWasOpen = true;
      // The viewer sits on the Board's right behind a draggable divider. Herdr keeps the
      // dragged width under the group id; the Board half keeps measuring its own width
      // so the columns still stack when that half gets narrow.
      return this.panelFrame(h_resizable("board-viewer-split").size_full().bg(t.canvas)
        .child(resizable_panel().size_range(280).child(root))
        .child(resizable_panel().size(this.viewerWidth()).size_range(260)
          .child(div().id("viewer-wrap").size_full().pl(4).pr(8).pt(2.5).pb(3)
            .on_size_change((size, cx) => { this.rightSplitWidth = size.width; cx.notify(); })
            .child(this.viewer.render(t, (px) => this.fs(px), this.viewSources(this.viewProject))))), t);
    }
    if (!narrowMod && inspectorShown) {
      this.splitWasOpen = true;
      return this.panelFrame(h_resizable("board-viewer-split").size_full().bg(t.canvas)
        .child(resizable_panel().size_range(280).child(root))
        .child(resizable_panel().size(this.inspectorWidth(modWidth)).size_range(260)
          .child(div().id("inspector-wrap").size_full().pl(4).pr(8).pt(2.5).pb(3)
            .on_size_change((size, cx) => { this.rightSplitWidth = size.width; cx.notify(); })
            .child(this.renderInspector(activeComp, t)))), t);
    }
    this.splitWasOpen = false;
    this.rightSplitWidth = 0;
    return this.panelFrame(root, t);
  }

  // The starting width only: after the first drag Herdr keeps the user's width under
  // the group id. Half the Board when its width is known, else a readable default.
  viewerWidth() {
    const w = this.size?.width;
    return w ? Math.max(420, Math.round(w / 2)) : 560;
  }

  /** @param {number} w the Board's whole width, split included */
  inspectorWidth(w) {
    return Number.isFinite(w) ? Math.max(320, Math.min(440, Math.round(w * 0.34))) : 360;
  }
}
