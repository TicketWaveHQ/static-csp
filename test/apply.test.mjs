// Writing the policy into pages, checking it, and processing a folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPolicy, checkPolicy, processDir, resolveConfig } from "../src/index.mjs";

const h = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const THEME = "document.documentElement.dataset.theme = localStorage.getItem('theme') || 'light';";
const PAGE = `<!doctype html>
<html lang="en-GB" style="--accent:#123456">
<head>
  <meta charset="utf-8">
  <title>Example</title>
  <script type="application/ld+json">{"@type":"WebSite","name":"Example"}</script>
  <script>${THEME}</script>
  <script type="module" src="/assets/site.js"></script>
</head>
<body>
  <script>window.addEventListener("load", () => {});</script>
</body>
</html>
`;

const folder = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "static-csp-test-"));
  for (const [name, html] of Object.entries(files)) {
    const parts = name.split("/");
    if (parts.length > 1) mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...parts), html);
  }
  return dir;
};
const read = (dir, name) => readFileSync(join(dir, ...name.split("/")), "utf8");

test("the policy goes first in <head>, after the leading <meta charset>, and lists each inline script", () => {
  const out = applyPolicy(PAGE);
  assert.equal(out.changed, true);
  const expected = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'self' ${[h(THEME), h('window.addEventListener("load", () => {});')].sort().join(" ")}" data-static-csp>\n  <title>`;
  assert.ok(out.html.includes(expected), out.html.slice(0, 400));
  assert.equal(out.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ""), PAGE);
});

test("without a leading charset declaration the policy is the very first element", () => {
  const out = applyPolicy("<html><head><title>x</title><meta charset=utf-8></head><body><script>a()</script></body></html>");
  assert.match(out.html, /^<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-[^']+'" data-static-csp><title>/);
});

test("a second run changes nothing", () => {
  const once = applyPolicy(PAGE).html;
  const twice = applyPolicy(once);
  assert.equal(twice.changed, false);
  assert.equal(twice.html, once);
  assert.equal(twice.html.match(/http-equiv="Content-Security-Policy"/g).length, 1);
});

test("a re-run updates the policy when a script or the configuration changes", () => {
  const once = applyPolicy(PAGE).html;
  const edited = once.replace("'light'", "'dark'");
  const updated = applyPolicy(edited);
  assert.equal(updated.changed, true);
  assert.ok(updated.html.includes(h(THEME.replace("'light'", "'dark'"))));
  assert.ok(!updated.html.includes(h(THEME)));
  const config = resolveConfig({ directives: { "connect-src": ["'self'"] } });
  assert.match(applyPolicy(once, { config }).html, /content="script-src [^"]+; connect-src 'self'"/);
});

test("stray or misplaced policies of ours are folded into one, in the right place", () => {
  const stale = `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-old'" data-static-csp>`;
  const messy = PAGE.replace("<head>", `<head>${stale}`).replace("<body>", `<body>${stale}`);
  const fixed = applyPolicy(messy);
  assert.equal(fixed.html, applyPolicy(PAGE).html);
});

test("a policy someone else wrote is left in place, with a warning", () => {
  const theirs = '<meta http-equiv="Content-Security-Policy" content="img-src \'self\'">';
  const out = applyPolicy(PAGE.replace("<title>", `${theirs}<title>`));
  assert.ok(out.html.includes(theirs));
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0].message, /browsers enforce both policies/);
});

test("a file with no <head> is left alone", () => {
  const out = applyPolicy("<p>fragment</p>");
  assert.equal(out.skipped, true);
  assert.equal(out.changed, false);
  assert.equal(out.html, "<p>fragment</p>");
});

test("checkPolicy passes a written page and explains what is wrong with others", () => {
  const good = applyPolicy(PAGE).html;
  assert.equal(checkPolicy(good).ok, true);

  assert.deepEqual(checkPolicy(PAGE).issues, ["no static-csp policy: run static-csp on the build output without --check"]);

  const edited = checkPolicy(good.replace("'light'", "'dark'"));
  assert.equal(edited.ok, false);
  assert.match(edited.issues[0], /^1 inline script on the page is not in the policy and would be blocked: 'sha256-/);
  assert.match(edited.issues[1], /^1 script hash in the policy matches nothing on the page: 'sha256-/);

  const config = resolveConfig({ directives: { "script-src": ["https://stats.example.com"], "object-src": ["'none'"] } });
  assert.deepEqual(checkPolicy(good, { config }).issues, [
    "the policy does not match the configuration: script-src needs https://stats.example.com; object-src missing",
  ]);

  const tag = good.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)[0];
  const moved = good.replace(tag, "").replace("<title>", `${tag}<title>`);
  assert.match(checkPolicy(moved).issues[0], /not the first element of <head>/);

  const doubled = good.replace("<title>", `${tag}<title>`);
  assert.match(checkPolicy(doubled).issues[0], /2 static-csp policies on one page/);
});

test("checkPolicy accepts a marker attribute a minifier has rewritten", () => {
  const good = applyPolicy(PAGE).html.replace("data-static-csp>", 'data-static-csp="">');
  assert.equal(checkPolicy(good).ok, true);
});

test("processDir writes every page, and writes nothing if any page is refused", () => {
  const dir = folder({
    "index.html": PAGE,
    "about/index.html": "<html><head></head><body><script>about()</script></body></html>",
    "legacy.htm": "<html><head></head><body><script>legacy()</script></body></html>",
    "google0123.html": "google-site-verification: google0123.html",
    "robots.txt": "User-agent: *",
  });
  const r = processDir(dir);
  assert.equal(r.ok, true);
  assert.equal(r.pages, 3);
  assert.equal(r.updated, 3);
  assert.equal(r.scripts, 4);
  assert.deepEqual(r.skipped, ["google0123.html"]);
  assert.ok(read(dir, "about/index.html").includes(h("about()")));
  assert.equal(read(dir, "google0123.html"), "google-site-verification: google0123.html");
  assert.equal(processDir(dir).current, 3);

  const bad = folder({
    "a.html": "<html><head></head><body><script>a()</script></body></html>",
    "b/index.html": '<html><head></head><body>\n<a href="#" onclick="b()">b</a></body></html>',
  });
  const refused = processDir(bad);
  assert.equal(refused.ok, false);
  assert.equal(refused.written, false);
  assert.deepEqual(refused.problems.map((p) => [p.file, p.line, p.column, p.kind]), [["b/index.html", 2, 13, "handler"]]);
  assert.ok(!read(bad, "a.html").includes("Content-Security-Policy"), "a.html must not be written when another page fails");
});

test("processDir refuses to run on too few pages, and honours exclude and routes", () => {
  const dir = folder({ "index.html": PAGE });
  const few = processDir(dir, { config: resolveConfig({ minPages: 2 }) });
  assert.equal(few.ok, false);
  assert.equal(few.tooFewPages, true);
  assert.ok(!read(dir, "index.html").includes("Content-Security-Policy"));

  const site = folder({
    "index.html": PAGE,
    "checkout/index.html": "<html><head></head><body></body></html>",
    "admin/index.html": '<html><head></head><body><button onclick="x()"></button></body></html>',
  });
  const config = resolveConfig({
    exclude: ["admin/**"],
    routes: [{ match: "checkout/**", directives: { "frame-src": ["https://pay.example"] } }],
  });
  const r = processDir(site, { config });
  assert.equal(r.ok, true);
  assert.equal(r.excluded, 1);
  assert.match(read(site, "checkout/index.html"), /content="script-src 'self'; frame-src https:\/\/pay\.example"/);
  assert.doesNotMatch(read(site, "index.html"), /frame-src/);
  assert.doesNotMatch(read(site, "admin/index.html"), /Content-Security-Policy/);
});

test("processDir in check mode never writes", () => {
  const dir = folder({ "index.html": PAGE });
  const before = statSync(join(dir, "index.html")).mtimeMs;
  const r = processDir(dir, { check: true });
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 1);
  assert.equal(read(dir, "index.html"), PAGE);
  assert.equal(statSync(join(dir, "index.html")).mtimeMs, before);
  processDir(dir);
  assert.equal(processDir(dir, { check: true }).ok, true);
});

test("processDir with styles \"hash\" hashes <style> blocks and refuses style attributes", () => {
  const dir = folder({ "index.html": "<html><head><style>.a{color:red}</style></head><body></body></html>" });
  const r = processDir(dir, { config: resolveConfig({ styles: "hash" }) });
  assert.equal(r.ok, true);
  assert.equal(r.styles, 1);
  assert.ok(read(dir, "index.html").includes(`style-src 'self' ${h(".a{color:red}")}`));

  const attr = folder({ "index.html": '<html><head></head><body><p style="color:red">x</p></body></html>' });
  const refused = processDir(attr, { config: resolveConfig({ styles: "hash" }) });
  assert.equal(refused.ok, false);
  assert.equal(refused.problems[0].kind, "style-attribute");
  const reported = processDir(attr, { config: resolveConfig({ styles: "report" }) });
  assert.equal(reported.ok, true);
  assert.equal(reported.notes.length, 1);
});
