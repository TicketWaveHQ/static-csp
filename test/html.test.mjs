// The scanner: which inline scripts are hashed, and what is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashSource, isJavaScriptUrl, scanHtml, scriptKind } from "../src/index.mjs";

// An independent hash, from the bytes as given.
const h = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const hashes = (html) => scanHtml(html).scripts.map((s) => s.hash);

test("hashSource matches the worked example in the CSP specification", () => {
  // CSP Level 2 and MDN use this script and this hash as their example.
  assert.equal(hashSource("alert('Hello, world.');"), "'sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng='");
});

test("CRLF and CR are hashed as the LF the parser turns them into, and NUL as U+FFFD", () => {
  assert.equal(hashSource("a();\r\nb();\rc();"), h("a();\nb();\nc();"));
  assert.equal(hashSource("x\0y"), h("x�y"));
});

test("whitespace inside a script is part of its hash", () => {
  assert.deepEqual(hashes("<script>\n  go();\n</script>"), [h("\n  go();\n")]);
  assert.notEqual(hashSource(" go();"), hashSource("go();"));
});

test("every kind of script a browser runs is hashed", () => {
  const page = [
    "<script>classic()</script>",
    '<script type="">empty()</script>',
    '<script type=" text/javascript ">padded()</script>',
    '<script type="TEXT/JAVASCRIPT">upper()</script>',
    '<script type="application/ecmascript">ecma()</script>',
    '<script type="module">mod()</script>',
    '<script type="importmap">{"imports":{}}</script>',
    '<script type="speculationrules">{"prerender":[]}</script>',
    '<script language="javascript">lang()</script>',
    "<script>\n</script>",
  ].join("\n");
  assert.deepEqual(scanHtml(page).scripts.map((s) => s.kind), [
    "classic", "classic", "classic", "classic", "classic", "module", "importmap", "speculationrules", "classic", "classic",
  ]);
});

test("data blocks, external scripts and empty scripts are not hashed", () => {
  const page = [
    '<script type="application/ld+json">{"@type":"WebSite"}</script>',
    '<script type="application/json" id="data">{"a":1}</script>',
    '<script type="text/template"><p>{{x}}</p></script>',
    '<script type="text/javascript; charset=utf-8">notRunByBrowsers()</script>',
    '<script type=" ">whitespaceType()</script>',
    '<script language="vbscript">x</script>',
    '<script src="/app.js">ignored()</script>',
    '<script src="">alsoIgnored()</script>',
    "<script></script>",
  ].join("\n");
  assert.deepEqual(hashes(page), []);
});

test("scriptKind follows the HTML Standard's type rules", () => {
  const k = (pairs) => scriptKind(new Map(pairs));
  assert.equal(k([]), "classic");
  assert.equal(k([["language", ""]]), "classic");
  assert.equal(k([["type", "module"]]), "module");
  assert.equal(k([["type", "MODULE"]]), "module");
  assert.equal(k([["type", "text/babel"]]), null);
  assert.equal(k([["type", "application/ld+json"]]), null);
});

test("a script ends at its end tag, whatever the script's text looks like", () => {
  const body = 'var s = "<div onclick=x>"; if (a < b) { document.write("<a href=\'javascript:1\'>"); }';
  const { scripts, problems } = scanHtml(`<head></head><script>${body}</script><p>after</p>`);
  assert.deepEqual(scripts.map((s) => s.hash), [h(body)]);
  assert.deepEqual(problems, []);
  assert.deepEqual(hashes("<SCRIPT>upper()</SCRIPT >"), [h("upper()")]);
  assert.deepEqual(hashes("<script>a()</scripts></script>"), [h("a()</scripts>")]);
});

test("comments, <noscript>, <textarea>, <title> and <style> contents are not markup", () => {
  const page = `<head><title>Why onclick= is <b onclick=bad> bad</title></head><body>
<!-- <script>commented()</script> <a onclick=x> -->
<!--> <script>afterAbruptComment()</script>
<noscript><img src="/pixel.gif" onload="x()"><script>never()</script></noscript>
<textarea><button onclick="x()"></button></textarea>
<style>.a::after { content: "<b onclick=x>"; }</style>
<p title="always online=yes">Text with onclick= in it, and an img alt="onload=".</p>
<img src="/a.png" alt="onload=">
</body>`;
  const { scripts, problems } = scanHtml(page);
  assert.deepEqual(scripts.map((s) => s.hash), [h("afterAbruptComment()")]);
  assert.deepEqual(problems, []);
});

test("inline handlers are refused on any element, with line and column", () => {
  const page = '<head></head><body>\n<button type="button" onclick="go()">Go</button>\n  <script src="/a.js" onload="ready()"></script>\n<svg><animate onbegin="x()"/></svg><body ONMOUSEOVER=y>';
  const { problems } = scanHtml(page);
  assert.deepEqual(problems.map((p) => [p.line, p.column, p.kind]), [
    [2, 23, "handler"],
    [3, 23, "handler"],
    [4, 15, "handler"],
    [4, 42, "handler"],
  ]);
  assert.match(problems[0].message, /^inline event handler onclick= on <button type="button" onclick="go\(\)">/);
  assert.match(problems[3].message, /onmouseover=/);
});

test("javascript: URLs are refused however they are written", () => {
  const urls = [
    "javascript:void(0)",
    " JavaScript:go()",
    "java\tscript:go()",
    "java&#x73;cript:go()",
    "&#106;avascript:go()",
    "javascript&colon;go()",
    "\u0001javascript:go()",
  ];
  for (const u of urls) assert.equal(isJavaScriptUrl(u), true, u);
  for (const u of ["/javascript:", "https://example.com/?javascript:", "#javascript", "javascripts/app.js"]) assert.equal(isJavaScriptUrl(u), false, u);
  const { problems } = scanHtml(`<head></head><a href="javascript:x()">a</a><form action='javascript:x()'></form><button formaction=javascript:x()>b</button><iframe src="javascript:x()"></iframe><svg><a xlink:href="javascript:x()"></a></svg><img src="/a.png" data-href="javascript:x()">`);
  assert.deepEqual(problems.map((p) => p.message.match(/in (\S+)=/)[1]), ["href", "action", "formaction", "src", "xlink:href"]);
});

test("attributes are read the way the HTML tokeniser reads them", () => {
  const { problems } = scanHtml(`<head></head><a/onclick=x>1</a><a href=/x onclick = "y">2</a><a title='>' onclick="z">3</a>`);
  assert.equal(problems.length, 3);
});

test("styles are left out unless asked for, then listed with lines", () => {
  const page = '<head><style>.a{color:red}</style></head>\n<body style="margin:0"><p style="">empty</p></body>';
  assert.deepEqual(scanHtml(page).styleBlocks, []);
  const scan = scanHtml(page, { styles: "report" });
  assert.deepEqual(scan.styleBlocks.map((s) => [s.line, s.hash]), [[1, h(".a{color:red}")]]);
  assert.deepEqual(scan.styleAttributes.map((s) => [s.line, s.column]), [[2, 7]]);
});

test("the head, and where the policy goes in it", () => {
  const insert = (html) => {
    const s = scanHtml(html);
    return s.insertAt === null ? null : html.slice(0, s.insertAt);
  };
  assert.equal(insert("<html><head><title>x</title>"), "<html><head>");
  assert.equal(insert('<html><head lang="en">\n  <meta charset="utf-8">\n  <title>x</title>'), '<html><head lang="en">\n  <meta charset="utf-8">');
  assert.equal(insert('<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>'), '<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">');
  assert.equal(insert('<head><title>x</title><meta charset="utf-8">'), "<head>");
  assert.equal(insert("<!-- <head> --><header>no head here</header>"), null);
  assert.equal(insert("<p>fragment</p>"), null);
  assert.equal(insert("<head></head>"), "<head>");
});

test("CSP <meta> elements are told apart: ours carry the marker", () => {
  const s = scanHtml('<head><meta http-equiv="content-security-policy" content="a" data-static-csp><meta http-equiv="Content-Security-Policy" content="img-src *"></head>');
  assert.deepEqual(s.ours.map((m) => m.content), ["a"]);
  assert.deepEqual(s.foreign.map((m) => m.content), ["img-src *"]);
});
