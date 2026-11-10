// The command as a build runs it: output, exit codes, configuration files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/static-csp.mjs", import.meta.url));
const run = (args, cwd) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const project = (pages, extra = {}) => {
  const cwd = mkdtempSync(join(tmpdir(), "static-csp-cli-"));
  mkdirSync(join(cwd, "dist"));
  for (let i = 0; i < pages; i++) {
    mkdirSync(join(cwd, "dist", `p${i}`));
    writeFileSync(join(cwd, "dist", `p${i}`, "index.html"), `<html><head><meta charset="utf-8"></head><body><script>p(${i})</script></body></html>`);
  }
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(cwd, name), text);
  return cwd;
};

test("writes every page and says what it did", () => {
  const cwd = project(3);
  const r = run(["dist"], cwd);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "static-csp: dist: 3 pages, 3 distinct inline scripts; 3 updated, 0 already current\n");
  assert.match(readFileSync(join(cwd, "dist", "p0", "index.html"), "utf8"), /<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-/);
  assert.equal(run(["dist"], cwd).stdout, "static-csp: dist: 3 pages, 3 distinct inline scripts; 0 updated, 3 already current\n");
});

test("--check fails before the write, passes after it, and fails again when a page changes", () => {
  const cwd = project(2);
  const before = run(["dist", "--check"], cwd);
  assert.equal(before.code, 1);
  assert.match(before.stderr, /^dist\/p0\/index\.html: error: no static-csp policy/m);
  assert.match(before.stderr, /2 pages of 2 with a missing or out-of-date policy/);
  run(["dist"], cwd);
  const after = run(["dist", "--check"], cwd);
  assert.equal(after.code, 0, after.stderr);
  assert.equal(after.stdout, "static-csp: every policy is current in dist (2 pages, 2 distinct inline scripts)\n");
  const file = join(cwd, "dist", "p1", "index.html");
  writeFileSync(file, readFileSync(file, "utf8").replace("p(1)", "p(1); track()"));
  const stale = run(["dist", "--check"], cwd);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /dist\/p1\/index\.html: error: 1 inline script on the page is not in the policy and would be blocked/);
});

test("an inline handler fails the build with file, line and column, and nothing is written", () => {
  const cwd = project(2);
  writeFileSync(join(cwd, "dist", "p1", "index.html"), '<html><head></head><body>\n\n  <button onclick="buy()">Buy</button></body></html>');
  const r = run(["dist"], cwd);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^dist\/p1\/index\.html:3:11: error: inline event handler onclick= on <button onclick="buy\(\)">/m);
  assert.match(r.stderr, /1 problem that no hash can allow; nothing was written/);
  assert.doesNotMatch(readFileSync(join(cwd, "dist", "p0", "index.html"), "utf8"), /Content-Security-Policy/);
});

test("too few pages, or no folder at all, fails rather than protect nothing", () => {
  const cwd = project(2);
  const few = run(["dist", "--min-pages", "5"], cwd);
  assert.equal(few.code, 1);
  assert.match(few.stderr, /only 2 pages with a <head> in dist, fewer than the 5 expected; is this the build output folder\? Nothing was written\./);
  const empty = project(0);
  assert.equal(run(["dist"], empty).code, 1);
  const missing = run(["no-such-folder"], cwd);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no build output folder at/);
});

test("reads static-csp.config.json from the current folder, with dir relative to it", () => {
  const config = {
    dir: "dist",
    minPages: 2,
    directives: { "script-src": ["https://stats.example.com"], "connect-src": ["'self'", "https://stats.example.com"] },
  };
  const cwd = project(2, { "static-csp.config.json": JSON.stringify(config) });
  const r = run([], cwd);
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(join(cwd, "dist", "p0", "index.html"), "utf8"), /content="script-src 'self' https:\/\/stats\.example\.com 'sha256-[^']+'; connect-src 'self' https:\/\/stats\.example\.com"/);
});

test("reads a module configuration given with --config", () => {
  const cwd = project(1, { "csp.mjs": 'export default { directives: { "object-src": ["\'none\'"] } };' });
  const r = run(["dist", "--config", "csp.mjs"], cwd);
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(join(cwd, "dist", "p0", "index.html"), "utf8"), /; object-src 'none'"/);
});

test("a bad configuration is a usage error that names the problem", () => {
  const cwd = project(1, { "static-csp.config.json": '{"directives":{"frame-ancestors":["\'none\'"]}}' });
  const r = run(["dist"], cwd);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /static-csp\.config\.json: directives: a <meta> policy cannot set frame-ancestors; send it as a response header/);
  const broken = project(1, { "static-csp.config.json": "{ not json" });
  assert.equal(run(["dist"], broken).code, 2);
});

test("command-line options override the file, and are checked", () => {
  const cwd = project(1, { "static-csp.config.json": '{"minPages": 9}' });
  assert.equal(run(["dist"], cwd).code, 1);
  assert.equal(run(["dist", "--min-pages", "1"], cwd).code, 0);
  assert.equal(run(["dist", "--min-pages", "many"], cwd).code, 2);
  assert.equal(run(["dist", "--styles", "inline"], cwd).code, 2);
  assert.equal(run(["dist", "--frobnicate"], cwd).code, 2);
  assert.equal(run(["a", "b"], cwd).code, 2);
});

test("--styles report lists inline styles without failing", () => {
  const cwd = project(0);
  writeFileSync(join(cwd, "dist", "index.html"), '<html><head><style>.a{}</style></head><body style="margin:0"></body></html>');
  const r = run(["dist", "--styles", "report"], cwd);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^dist\/index\.html:1:13: note: inline <style> block \(its hash would be 'sha256-/m);
  assert.match(r.stderr, /^dist\/index\.html:1:45: note: style= attribute on <body style="margin:0">/m);
});

test("--help and --version", () => {
  const help = run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: static-csp \[dir\] \[options\]/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(run(["--version"]).stdout.trim(), pkg.version);
});
