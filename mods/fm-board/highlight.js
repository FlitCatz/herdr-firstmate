// Adapted from the sibling herdr-pr-viewer mod (mods/herdr-pr-viewer/highlight.js).
// Maps Herdr theme tokens to EditorState syntax colors for the Files viewer.

/** @typedef {"plain" | "keyword" | "string" | "comment" | "number" | "type" | "function" | "constant"} TokenKind */

/**
 * Maps a token kind to the matching Herdr `theme()` token.
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
  const color = (/** @type {TokenKind} */ kind) => syntaxColor(t, kind);
  return {
    keyword: color("keyword"), string: color("string"), comment: color("comment"), function: color("function"),
    type: color("type"), number: color("number"), constant: color("constant"), boolean: color("constant"),
    "string.escape": color("constant"), variable: color("plain"), operator: color("plain"), punctuation: color("plain"),
  };
}
