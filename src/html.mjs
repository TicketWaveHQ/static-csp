// A small HTML scanner: enough of the HTML tokeniser to find what a
// Content-Security-Policy governs, and nothing more. It never builds a tree.
//
// It finds the inline scripts a browser would run (and, on request, inline
// styles), the attributes no hash can allow (inline event handlers and
// javascript: URLs), the <head> start tag, and any CSP <meta> elements.
import { createHash } from "node:crypto";

/** The attribute that marks the <meta> this tool wrote, so a re-run can replace it. */
export const MARKER = "data-static-csp";

// HTML Standard, "JavaScript MIME type essence match".
const JS_MIME = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

// Elements whose content the tokeniser reads as text, not markup, while
// scripting is enabled (the only case in which a CSP matters).
const RAW_TEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "textarea", "title"]);

// Attributes that navigate or load, where a javascript: URL would run code.
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "data"]);

const isSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
const isAlpha = (c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/**
 * The CSP hash source for an inline script or style, as the browser computes
 * it: SHA-256 of the UTF-8 text after the parser has turned CRLF and CR into
 * LF and NUL into U+FFFD.
 * @param {string} text
 * @returns {string} for example `'sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng='`
 */
export function hashSource(text) {
  const normalised = text.replace(/\r\n?/g, "\n").replace(/\0/g, "�");
  return `'sha256-${createHash("sha256").update(normalised, "utf8").digest("base64")}'`;
}

/**
 * What kind of script a <script> start tag declares, following the HTML
 * Standard's "prepare the script element": "classic", "module", "importmap",
 * "speculationrules", or null for a data block (JSON-LD, templates), which
 * is never run and so needs no hash.
 * @param {Map<string, string>} attrs
 */
export function scriptKind(attrs) {
  const type = attrs.get("type");
  const language = attrs.get("language");
  let t;
  if (type === undefined) t = language ? `text/${language}` : "text/javascript";
  else if (type === "") t = "text/javascript";
  else t = type;
  t = t.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").toLowerCase();
  if (JS_MIME.has(t)) return "classic";
  if (t === "module" || t === "importmap" || t === "speculationrules") return t;
  return null;
}

/**
 * Reads a start or end tag beginning at `i` (where html[i] is "<").
 * Returns null if this "<" does not open a tag, including a tag cut off by
 * the end of the file.
 */
function readTag(html, i) {
  const n = html.length;
  let j = i + 1;
  let closing = false;
  if (html.charCodeAt(j) === 0x2f) {
    closing = true;
    j += 1;
  }
  if (!isAlpha(html.charCodeAt(j))) return null;
  let k = j;
  while (k < n) {
    const c = html.charCodeAt(k);
    if (isSpace(c) || c === 0x2f || c === 0x3e) break;
    k += 1;
  }
  const name = html.slice(j, k).toLowerCase();
  const attrs = [];
  let p = k;
  for (;;) {
    while (p < n && (isSpace(html.charCodeAt(p)) || html.charCodeAt(p) === 0x2f)) p += 1;
    if (p >= n) return null;
    if (html.charCodeAt(p) === 0x3e) return { name, closing, attrs, start: i, end: p + 1 };
    const nameStart = p;
    p += 1; // the first character may be "=", which then belongs to the name
    while (p < n) {
      const c = html.charCodeAt(p);
      if (isSpace(c) || c === 0x2f || c === 0x3e || c === 0x3d) break;
      p += 1;
    }
    const attrName = html.slice(nameStart, p).toLowerCase();
    let q = p;
    while (q < n && isSpace(html.charCodeAt(q))) q += 1;
    let value = "";
    if (html.charCodeAt(q) === 0x3d) {
      q += 1;
      while (q < n && isSpace(html.charCodeAt(q))) q += 1;
      const quote = html[q];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, q + 1);
        if (close === -1) return null;
        value = html.slice(q + 1, close);
        p = close + 1;
      } else {
        let r = q;
        while (r < n && !isSpace(html.charCodeAt(r)) && html.charCodeAt(r) !== 0x3e) r += 1;
        value = html.slice(q, r);
        p = r;
      }
    }
    attrs.push({ name: attrName, value, index: nameStart });
  }
}

/** Where a comment that starts at `i` ends (HTML Standard comment states). */
function commentEnd(html, i) {
  if (html.startsWith("<!-->", i)) return i + 5;
  if (html.startsWith("<!--->", i)) return i + 6;
  const close = /--!?>/g;
  close.lastIndex = i + 4;
  const m = close.exec(html);
  return m ? m.index + m[0].length : html.length;
}

/** The start of the end tag that closes raw text opened by `name`, or the end of the file. */
function rawTextEnd(html, from, name) {
  const re = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi");
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return { contentEnd: html.length, next: html.length };
  const gt = html.indexOf(">", m.index);
  return { contentEnd: m.index, next: gt === -1 ? html.length : gt + 1 };
}

/** Character references a javascript: URL can hide behind. */
function decodeForScheme(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff)))
    .replace(/&colon;/g, ":")
    .replace(/&Tab;/g, "\t")
    .replace(/&NewLine;/g, "\n");
}

/** True if a URL attribute's value would run as a javascript: URL. */
export function isJavaScriptUrl(value) {
  const url = decodeForScheme(value)
    .replace(/^[\u0000- ]+|[\u0000- ]+$/g, "")
    .replace(/[\t\n\r]/g, "");
  return /^javascript:/i.test(url);
}

/** Turns string offsets into 1-based line and column numbers. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
}

const snippet = (html, tag) => {
  const text = html.slice(tag.start, tag.end).replace(/\s+/g, " ");
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

/**
 * Scans one HTML document.
 * @param {string} html
 * @param {{ styles?: "ignore" | "report" | "hash" }} [options]
 */
export function scanHtml(html, { styles = "ignore" } = {}) {
  const at = lineIndex(html);
  const scripts = []; // inline scripts a browser would run
  const styleBlocks = []; // inline <style> elements (styles !== "ignore")
  const styleAttributes = []; // style= attributes (styles !== "ignore")
  const problems = []; // what no hash can allow
  const ours = []; // CSP <meta> elements this tool wrote
  const foreign = []; // CSP <meta> elements someone else wrote
  let head = null;
  let awaitingFirst = false;
  let firstInHead = null;

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      i = commentEnd(html, lt);
      continue;
    }
    const next = html.charCodeAt(lt + 1);
    if (next === 0x21 || next === 0x3f) {
      // <!DOCTYPE>, <![CDATA[ ]]> and <?xml ?> are read as bogus comments up to ">".
      const gt = html.indexOf(">", lt);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    const tag = readTag(html, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (tag.closing) {
      if (awaitingFirst) awaitingFirst = false;
      continue;
    }

    const attrs = new Map();
    for (const a of tag.attrs) if (!attrs.has(a.name)) attrs.set(a.name, a.value);

    for (const a of tag.attrs) {
      if (/^on[a-z]+$/.test(a.name)) {
        problems.push({
          ...at(a.index),
          kind: "handler",
          message: `inline event handler ${a.name}= on ${snippet(html, tag)}: no hash can allow it; attach it from a script with addEventListener`,
        });
      } else if (URL_ATTRIBUTES.has(a.name) && isJavaScriptUrl(a.value)) {
        problems.push({
          ...at(a.index),
          kind: "javascript-url",
          message: `javascript: URL in ${a.name}= on ${snippet(html, tag)}: no hash can allow it; use a real URL, or a button with a listener`,
        });
      } else if (a.name === "style" && styles !== "ignore" && a.value.trim() !== "") {
        styleAttributes.push({ ...at(a.index), tag: snippet(html, tag) });
      }
    }

    const isCspMeta =
      tag.name === "meta" && (attrs.get("http-equiv") ?? "").trim().toLowerCase() === "content-security-policy";
    if (isCspMeta) {
      if (attrs.has(MARKER)) ours.push({ start: tag.start, end: tag.end, content: attrs.get("content") ?? "", ...at(tag.start) });
      else foreign.push({ ...at(tag.start), content: attrs.get("content") ?? "" });
    }

    if (tag.name === "head" && !head) {
      head = { start: tag.start, end: tag.end };
      awaitingFirst = true;
    } else if (awaitingFirst && !(isCspMeta && attrs.has(MARKER))) {
      firstInHead = { tag, attrs };
      awaitingFirst = false;
    }

    if (tag.name === "plaintext") break;
    if (!RAW_TEXT.has(tag.name)) continue;

    const { contentEnd, next: after } = rawTextEnd(html, tag.end, tag.name);
    const body = html.slice(tag.end, contentEnd);
    i = after;
    if (tag.name === "script") {
      const kind = scriptKind(attrs);
      if (!attrs.has("src") && kind && body.length) scripts.push({ hash: hashSource(body), kind, ...at(tag.start) });
    } else if (tag.name === "style" && styles !== "ignore" && body.length) {
      styleBlocks.push({ hash: hashSource(body), ...at(tag.start) });
    }
  }

  // The policy goes first in <head>, after a leading character-encoding
  // declaration, which has to stay within the first 1024 bytes.
  let insertAt = null;
  if (head) {
    insertAt = head.end;
    if (firstInHead && firstInHead.tag.name === "meta") {
      const a = firstInHead.attrs;
      const encoding = a.has("charset") || (a.get("http-equiv") ?? "").trim().toLowerCase() === "content-type";
      if (encoding) insertAt = firstInHead.tag.end;
    }
  }

  return { head: Boolean(head), insertAt, scripts, styleBlocks, styleAttributes, problems, ours, foreign };
}
