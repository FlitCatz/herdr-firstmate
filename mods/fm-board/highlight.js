// Adapted from the sibling herdr-pr-viewer mod (mods/herdr-pr-viewer/highlight.js).
// Lightweight syntax tokenizer for diff lines, using Herdr theme tokens.
// Zero dependencies and incremental per line slice so large diffs stay fast.

/** @typedef {"plain" | "keyword" | "string" | "comment" | "number" | "type" | "function" | "constant"} TokenKind */
/** @typedef {{ kind: TokenKind, text: string }} Span */
/** @typedef {"csharp" | "ts" | "dart" | "rust" | "json" | "yaml" | "markdown" | "shell" | "plain"} Language */
/** @typedef {{ kind: string, text: string }} DiffLineRow */

// First 160 rows highlight synchronously; longer diffs highlight in 80-row chunks.
export const HIGHLIGHT_SYNC_MAX = 160;
export const HIGHLIGHT_CHUNK = 80;
export const MAX_LINE_SPANS = 80;

const EXT_MAP = /** @type {Record<string, Language>} */ ({
  cs: "csharp", csx: "csharp",
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
  dart: "dart",
  rs: "rust",
  json: "json", jsonc: "json",
  yml: "yaml", yaml: "yaml",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  sh: "shell", bash: "shell", zsh: "shell", ksh: "shell", fish: "shell",
});

const SHELL_NAMES = new Set([".bashrc", ".zshrc", ".bash_profile", ".zprofile", ".profile"]);

/** @param {string} path @returns {Language} */
export function detectLanguage(path) {
  const base = String(path ?? "").split("/").pop()?.toLowerCase() ?? "";
  if (SHELL_NAMES.has(base)) return "shell";
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "plain";
  return EXT_MAP[base.slice(dot + 1)] ?? "plain";
}

/**
 * Maps a tokenizer span kind to the matching Herdr `theme()` token.
 * @param {Record<string, any>} t
 * @param {TokenKind} kind
 */
export function syntaxColor(t, kind) {
  switch (kind) {
    case "keyword": return t.ansi5;
    case "string": return t.ansi2;
    case "comment": return t.dim;
    case "number": return t.ansi1;
    case "type": return t.ansi3;
    case "function": return t.ansi4;
    case "constant": return t.ansi6;
    default: return t.foreground;
  }
}

/**
 * The same token table as the `syntax` colors of Herdr's code `Editor`.
 * @param {Record<string, any>} t
 * @returns {Record<string, string>}
 */
export function editorSyntax(t) {
  const color = (kind) => syntaxColor(t, kind);
  return {
    keyword: color("keyword"), string: color("string"), comment: color("comment"), function: color("function"),
    type: color("type"), number: color("number"), constant: color("constant"), boolean: color("constant"),
    "string.escape": color("constant"), variable: color("plain"), operator: color("plain"), punctuation: color("plain"),
  };
}

/**
 * Appends an 8-bit hex alpha suffix to a `#rrggbb` Herdr theme color.
 * @param {any} color
 * @param {string} alpha
 */
export function tint(color, alpha) {
  return /^#[0-9a-f]{6}$/i.test(String(color)) ? `${color}${alpha}` : color;
}

/**
 * Bounds a tokenized line to `MAX_LINE_SPANS` and returns `null` when plain text suffices.
 * @param {Span[] | null | undefined} rawSpans
 * @returns {Span[] | null}
 */
export function capLineSpans(rawSpans) {
  if (!rawSpans || (rawSpans.length === 1 && rawSpans[0].kind === "plain")) return null;
  if (rawSpans.length <= MAX_LINE_SPANS) return rawSpans;
  return [
    ...rawSpans.slice(0, MAX_LINE_SPANS - 1),
    { kind: "plain", text: rawSpans.slice(MAX_LINE_SPANS - 1).map((sp) => sp.text).join("") },
  ];
}

const CODE_SPECS = {
  csharp: {
    lineComment: "//",
    blockComment: true,
    keywords: new Set([
      "abstract", "as", "async", "await", "base", "break", "case", "catch", "checked", "class",
      "const", "continue", "default", "delegate", "do", "else", "enum", "event", "explicit",
      "extern", "finally", "fixed", "for", "foreach", "get", "goto", "if", "implicit", "in",
      "init", "interface", "internal", "is", "lock", "namespace", "new", "operator", "out",
      "override", "params", "private", "protected", "public", "readonly", "record", "ref",
      "required", "return", "sealed", "set", "sizeof", "stackalloc", "static", "struct",
      "switch", "this", "throw", "try", "typeof", "unchecked", "unsafe", "using", "var",
      "virtual", "volatile", "when", "where", "while", "with", "yield",
    ]),
    constants: new Set(["true", "false", "null"]),
    types: new Set(["bool", "byte", "char", "decimal", "double", "dynamic", "float", "int", "long", "nint", "nuint", "object", "sbyte", "short", "string", "uint", "ulong", "ushort", "void", "Task", "ValueTask"]),
  },
  ts: {
    lineComment: "//",
    blockComment: true,
    keywords: new Set([
      "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
      "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends",
      "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "infer",
      "instanceof", "interface", "is", "keyof", "let", "module", "namespace", "new", "of",
      "override", "private", "protected", "public", "readonly", "return", "satisfies", "set",
      "static", "super", "switch", "this", "throw", "try", "type", "typeof", "var", "void",
      "while", "with", "yield",
    ]),
    constants: new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]),
    types: new Set(["any", "bigint", "boolean", "never", "number", "object", "string", "symbol", "unknown", "void", "Array", "Map", "Set", "Promise", "Record"]),
  },
  dart: {
    lineComment: "//",
    blockComment: true,
    keywords: new Set([
      "abstract", "as", "assert", "async", "await", "base", "break", "case", "catch", "class",
      "const", "continue", "covariant", "default", "deferred", "do", "else", "enum", "export",
      "extends", "extension", "external", "factory", "final", "finally", "for", "get", "hide",
      "if", "implements", "import", "in", "interface", "is", "late", "library", "mixin", "new",
      "on", "operator", "part", "required", "rethrow", "return", "sealed", "set", "show",
      "static", "super", "switch", "sync", "this", "throw", "try", "typedef", "var", "when",
      "while", "with", "yield",
    ]),
    constants: new Set(["true", "false", "null"]),
    types: new Set(["bool", "double", "dynamic", "int", "num", "Object", "String", "void", "Future", "Stream", "List", "Map", "Set", "Widget"]),
  },
  rust: {
    lineComment: "//",
    blockComment: true,
    keywords: new Set([
      "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
      "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut",
      "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "type",
      "unsafe", "use", "where", "while",
    ]),
    constants: new Set(["true", "false", "None", "Some", "Ok", "Err"]),
    types: new Set(["bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "i128", "isize", "str", "u8", "u16", "u32", "u64", "u128", "usize", "Box", "Option", "Result", "String", "Vec"]),
  },
  json: {
    lineComment: "//",
    blockComment: true,
    keywords: new Set(),
    constants: new Set(["true", "false", "null"]),
    types: new Set(),
  },
  shell: {
    lineComment: "#",
    blockComment: false,
    keywords: new Set([
      "break", "case", "continue", "do", "done", "elif", "else", "esac", "exec", "exit",
      "export", "fi", "for", "function", "if", "in", "local", "readonly", "return", "set",
      "shift", "then", "trap", "unset", "until", "while",
    ]),
    constants: new Set(["true", "false"]),
    types: new Set(),
  },
};

/** @param {Span[]} out @param {TokenKind} kind @param {string} text */
function pushSpan(out, kind, text) {
  if (!text) return;
  const prev = out[out.length - 1];
  if (prev && prev.kind === kind) prev.text += text;
  else out.push({ kind, text });
}

/** @param {string} line @param {number} start @param {string} quote */
function scanQuoted(line, start, quote) {
  let i = start + 1;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return line.length;
}

const NUMBER_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)(?:[uUiIfF](?:8|16|32|64|128|size)|[fFdDmMlLuU])?/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const PASCAL_TYPE_RE = /^[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/;
const ALL_CAPS_RE = /^[A-Z][A-Z0-9_]{1,}$/;

/**
 * Tokenizes one line of a C-like/Rust/JSON/Shell language.
 * @param {string} line
 * @param {"csharp" | "ts" | "dart" | "rust" | "json" | "shell"} lang
 * @param {boolean | null} inComment
 * @returns {{ spans: Span[], inComment: boolean | null }}
 */
function scanCodeLine(line, lang, inComment) {
  const spec = CODE_SPECS[lang];
  /** @type {Span[]} */
  const spans = [];
  let i = 0;

  if (inComment === null) {
    if (spec.blockComment && /^\s*\*(?:\/|\s|$)/.test(line)) {
      const end = line.indexOf("*/");
      if (end === -1) {
        pushSpan(spans, "comment", line);
        return { spans, inComment: null };
      }
      pushSpan(spans, "comment", line.slice(0, end + 2));
      i = end + 2;
    }
    inComment = false;
  }

  while (i < line.length) {
    if (inComment) {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        pushSpan(spans, "comment", line.slice(i));
        return { spans, inComment: true };
      }
      pushSpan(spans, "comment", line.slice(i, end + 2));
      i = end + 2;
      inComment = false;
      continue;
    }

    const rest = line.slice(i);
    if (spec.lineComment && rest.startsWith(spec.lineComment)) {
      if (lang !== "shell" || i === 0 || /\s|[;|&(]/.test(line[i - 1])) {
        pushSpan(spans, "comment", rest);
        return { spans, inComment: false };
      }
    }
    if (spec.blockComment && rest.startsWith("/*")) {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        pushSpan(spans, "comment", rest);
        return { spans, inComment: true };
      }
      pushSpan(spans, "comment", line.slice(i, end + 2));
      i = end + 2;
      continue;
    }

    const ch = line[i];
    if (ch === '"' || ch === "`" || (ch === "'" && (lang === "ts" || lang === "dart" || lang === "shell"))) {
      const end = scanQuoted(line, i, ch);
      const token = line.slice(i, end);
      const isJsonKey = lang === "json" && ch === '"' && /^\s*:/.test(line.slice(end));
      pushSpan(spans, isJsonKey ? "constant" : "string", token);
      i = end;
      continue;
    }
    if (ch === "'" && (lang === "rust" || lang === "csharp")) {
      const charLit = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|.)|[^'\\])'/.exec(rest);
      if (charLit) {
        pushSpan(spans, "string", charLit[0]);
        i += charLit[0].length;
        continue;
      }
      if (lang === "rust") {
        const life = /^'[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
        if (life) {
          pushSpan(spans, "type", life[0]);
          i += life[0].length;
          continue;
        }
      }
    }

    if (lang === "shell" && ch === "$") {
      const envVar = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*_-])/.exec(rest);
      if (envVar) {
        pushSpan(spans, "constant", envVar[0]);
        i += envVar[0].length;
        continue;
      }
    }

    if (/\d/.test(ch) && (i === 0 || !/[A-Za-z0-9_$]/.test(line[i - 1]))) {
      const num = NUMBER_RE.exec(rest);
      if (num) {
        pushSpan(spans, "number", num[0]);
        i += num[0].length;
        continue;
      }
    }

    const id = IDENT_RE.exec(rest);
    if (id) {
      const word = id[0];
      const next = i + word.length;
      /** @type {TokenKind} */
      let kind = "plain";
      if (spec.keywords.has(word)) kind = "keyword";
      else if (spec.constants.has(word)) kind = "constant";
      else if (spec.types.has(word)) kind = "type";
      else if (lang !== "json" && lang !== "shell" && /^\s*(?:<[^>\n]{1,60}>\s*)?\(/.test(line.slice(next))) kind = "function";
      else if (lang !== "json" && lang !== "shell" && PASCAL_TYPE_RE.test(word)) kind = "type";
      else if (lang !== "json" && ALL_CAPS_RE.test(word)) kind = "constant";
      pushSpan(spans, kind, word);
      i = next;
      continue;
    }

    pushSpan(spans, "plain", ch);
    i += 1;
  }

  return { spans, inComment };
}

/** @param {string} line @returns {Span[]} */
function scanYamlLine(line) {
  /** @type {Span[]} */
  const spans = [];
  let pos = 0;

  const keyMatch = /^(\s*(?:-\s+)?)([A-Za-z0-9_.-]+)(\s*:)/.exec(line);
  if (keyMatch) {
    pushSpan(spans, "plain", keyMatch[1]);
    pushSpan(spans, "constant", keyMatch[2]);
    pushSpan(spans, "plain", keyMatch[3]);
    pos = keyMatch[0].length;
  }

  while (pos < line.length) {
    const ch = line[pos];
    if (ch === "#" && (pos === 0 || /\s/.test(line[pos - 1]))) {
      pushSpan(spans, "comment", line.slice(pos));
      break;
    }
    if (ch === '"' || ch === "'") {
      const end = scanQuoted(line, pos, ch);
      pushSpan(spans, "string", line.slice(pos, end));
      pos = end;
      continue;
    }
    if (pos === 0 || /\s/.test(line[pos - 1])) {
      const rest = line.slice(pos);
      const val = /^(?:true|false|null|~)(?=\s|$|#)/.exec(rest);
      if (val) {
        pushSpan(spans, "constant", val[0]);
        pos += val[0].length;
        continue;
      }
      const num = /^-?\d[\d_]*(?:\.[\d_]+)?(?=\s|$|#)/.exec(rest);
      if (num) {
        pushSpan(spans, "number", num[0]);
        pos += num[0].length;
        continue;
      }
    }
    pushSpan(spans, "plain", ch);
    pos += 1;
  }
  return spans;
}

/** @param {string} line @returns {Span[]} */
function scanMarkdownLine(line) {
  if (/^\s*```/.test(line)) return [{ kind: "comment", text: line }];
  if (/^\s*#{1,6}\s/.test(line)) return [{ kind: "keyword", text: line }];
  /** @type {Span[]} */
  const spans = [];
  let i = 0;
  const marker = /^(\s*(?:>+|[-*+]|\d+\.)\s+)/.exec(line);
  if (marker) {
    pushSpan(spans, "type", marker[0]);
    i = marker[0].length;
  }
  while (i < line.length) {
    const ch = line[i];
    if (ch === "`") {
      const end = line.indexOf("`", i + 1);
      if (end !== -1) {
        pushSpan(spans, "string", line.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(line.slice(i));
      if (link) {
        pushSpan(spans, "plain", "[");
        pushSpan(spans, "function", link[1]);
        pushSpan(spans, "plain", "](");
        pushSpan(spans, "string", link[2]);
        pushSpan(spans, "plain", ")");
        i += link[0].length;
        continue;
      }
    }
    pushSpan(spans, "plain", ch);
    i += 1;
  }
  return spans;
}

/**
 * Tokenizes one line of code for `lang`.
 * @param {string} line
 * @param {Language} lang
 * @param {boolean | null} [inComment]
 * @returns {{ spans: Span[], inComment: boolean | null }}
 */
export function highlightLine(line, lang, inComment = false) {
  if (!line) return { spans: [{ kind: "plain", text: "" }], inComment };
  if (lang === "plain") return { spans: [{ kind: "plain", text: line }], inComment: false };
  if (lang === "yaml") return { spans: scanYamlLine(line), inComment: false };
  if (lang === "markdown") return { spans: scanMarkdownLine(line), inComment: false };
  return scanCodeLine(line, lang, inComment);
}

/**
 * Incrementally highlights diff rows up to `limit`, tracking separate old/new block-comment
 * state across deleted/added/context lines within each hunk and caching computed rows.
 * Row kinds are the viewer's `diffRows` kinds: `"@"`, `"-"`, `"+"`, `" "`, and `""`.
 */
export class DiffHighlighter {
  constructor() {
    /** @type {{ path: string, patch: string | null, lang: Language, lines: (Span[] | null)[], oldComment: boolean | null, newComment: boolean | null } | null} */
    this.cache = null;
  }

  /**
   * @param {string} path
   * @param {string | null} patch
   * @param {DiffLineRow[]} rows
   * @param {number} limit
   * @returns {(Span[] | null)[]}
   */
  highlight(path, patch, rows, limit) {
    if (!this.cache || this.cache.path !== path || this.cache.patch !== patch) {
      this.cache = { path, patch, lang: detectLanguage(path), lines: [], oldComment: null, newComment: null };
    }
    const c = this.cache;
    const target = Math.min(limit, rows.length);
    for (let i = c.lines.length; i < target; i++) {
      const r = rows[i];
      if (r.kind === "@") {
        c.oldComment = null;
        c.newComment = null;
        c.lines.push(null);
      } else if (r.kind === "") {
        c.lines.push(null);
      } else if (c.lang === "plain") {
        c.lines.push([{ kind: "plain", text: r.text }]);
      } else if (r.kind === "-") {
        const res = highlightLine(r.text, c.lang, c.oldComment);
        c.oldComment = res.inComment;
        c.lines.push(res.spans);
      } else if (r.kind === "+") {
        const res = highlightLine(r.text, c.lang, c.newComment);
        c.newComment = res.inComment;
        c.lines.push(res.spans);
      } else {
        const res = highlightLine(r.text, c.lang, c.newComment);
        c.oldComment = res.inComment;
        c.newComment = res.inComment;
        c.lines.push(res.spans);
      }
    }
    return c.lines;
  }
}
