// Configuration: validation, merging, routes, and the policy string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, configWarnings, directivesFor, globToRegExp, parsePolicy, resolveConfig, serialisePolicy } from "../src/index.mjs";

const policy = (raw, file = "index.html", hashes = {}) => serialisePolicy(directivesFor(resolveConfig(raw), file, hashes));
const refuses = (raw, pattern) => assert.throws(() => resolveConfig(raw), (e) => e instanceof ConfigError && pattern.test(e.message));

test("with no configuration the policy is script-src 'self' plus the page's hashes", () => {
  assert.equal(policy({}), "script-src 'self'");
  assert.equal(policy({}, "index.html", { scriptHashes: ["'sha256-a'", "'sha256-b'"] }), "script-src 'self' 'sha256-a' 'sha256-b'");
});

test("configured sources are merged after the defaults, each kept once", () => {
  const raw = {
    directives: {
      "script-src": ["'self'", "https://stats.example.com", "'wasm-unsafe-eval'"],
      "connect-src": "'self' https://stats.example.com",
      "object-src": ["'none'"],
      "upgrade-insecure-requests": [],
    },
  };
  assert.equal(
    policy(raw, "index.html", { scriptHashes: ["'sha256-x'"] }),
    "script-src 'self' https://stats.example.com 'wasm-unsafe-eval' 'sha256-x'; connect-src 'self' https://stats.example.com; object-src 'none'; upgrade-insecure-requests",
  );
  assert.equal(policy({ directives: { "script-src": "'SELF'" } }), "script-src 'self'");
  assert.equal(policy({ directives: { "img-src": ["https://a.example/A/", "https://a.example/a/"] } }), "script-src 'self'; img-src https://a.example/A/ https://a.example/a/");
});

test("'strict-dynamic' is allowed, with a warning about <script src>", () => {
  assert.deepEqual(configWarnings(resolveConfig({})), []);
  const [warning] = configWarnings(resolveConfig({ routes: [{ match: "**", directives: { "script-src": ["'strict-dynamic'"] } }] }));
  assert.match(warning, /'strict-dynamic' makes browsers ignore 'self' and host sources/);
});

test("routes add sources to the pages they match, in order", () => {
  const raw = {
    directives: { "frame-src": ["'none'"] },
    routes: [
      { match: "checkout/**", directives: { "script-src": ["https://js.payments.example"], "frame-src": ["https://js.payments.example"] } },
      { match: ["**/print.html", "/about/index.html"], directives: { "img-src": ["data:"] } },
    ],
  };
  assert.equal(policy(raw, "index.html"), "script-src 'self'; frame-src 'none'");
  assert.equal(policy(raw, "checkout/index.html"), "script-src 'self' https://js.payments.example; frame-src https://js.payments.example");
  assert.equal(policy(raw, "checkout/step/2.html"), "script-src 'self' https://js.payments.example; frame-src https://js.payments.example");
  assert.equal(policy(raw, "guides/x/print.html"), "script-src 'self'; frame-src 'none'; img-src data:");
  assert.equal(policy(raw, "about/index.html"), "script-src 'self'; frame-src 'none'; img-src data:");
});

test("hashes go into script-src-elem too when the configuration sets it", () => {
  assert.equal(
    policy({ directives: { "script-src-elem": ["'self'"] } }, "index.html", { scriptHashes: ["'sha256-x'"] }),
    "script-src 'self' 'sha256-x'; script-src-elem 'self' 'sha256-x'",
  );
});

test("with styles \"hash\", style-src gets 'self' and the style hashes", () => {
  assert.equal(
    policy({ styles: "hash", directives: { "style-src": ["https://fonts.example.com"] } }, "index.html", { styleHashes: ["'sha256-s'"] }),
    "script-src 'self'; style-src 'self' https://fonts.example.com 'sha256-s'",
  );
  assert.equal(policy({ styles: "report" }, "index.html", { styleHashes: ["'sha256-s'"] }), "script-src 'self'");
});

test("directives a <meta> policy cannot carry are refused", () => {
  refuses({ directives: { "frame-ancestors": ["'none'"] } }, /cannot set frame-ancestors; send it as a response header/);
  refuses({ directives: { "report-uri": ["/csp"] } }, /cannot set report-uri/);
  refuses({ routes: [{ match: "**", directives: { sandbox: [] } }] }, /routes\[0\]\.directives: .*sandbox/);
});

test("sources that would weaken or break the policy are refused", () => {
  refuses({ directives: { "script-src": ["'unsafe-inline'"] } }, /'unsafe-inline' would let any inline script run/);
  refuses({ directives: { "script-src-attr": ["'unsafe-hashes'"] } }, /'unsafe-hashes'/);
  refuses({ directives: { "script-src": ["'nonce-abc'"] } }, /same for every visitor/);
  refuses({ directives: { "connect-src": ["https://a.example;script-src *"] } }, /not a valid source/);
  refuses({ directives: { "connect-src": ['https://a.example"'] } }, /not a valid source/);
  refuses({ directives: { "img-src": [42] } }, /must be a string or an array of strings/);
  refuses({ styles: "hash", directives: { "style-src": ["'unsafe-inline'"] } }, /ignored once a policy lists style hashes/);
  // Without style hashing, inline styles may be allowed: the meta then only governs scripts.
  assert.equal(policy({ directives: { "style-src": ["'self'", "'unsafe-inline'"] } }), "script-src 'self'; style-src 'self' 'unsafe-inline'");
});

test("a mistyped key or value is refused, not ignored", () => {
  refuses({ directive: {} }, /unknown configuration key "directive"/);
  refuses({ styles: "inline" }, /styles must be one of ignore, report, hash/);
  refuses({ minPages: -1 }, /minPages/);
  refuses({ minPages: 2.5 }, /minPages/);
  refuses({ routes: [{ directives: {} }] }, /routes\[0\]\.match is required/);
  refuses({ routes: [{ match: "a", directive: {} }] }, /routes\[0\]: unknown key "directive"/);
  refuses({ directives: { "Script Src": [] } }, /not a directive name/);
  assert.doesNotThrow(() => resolveConfig({ $comment: "notes are allowed" }));
});

test("'none' is dropped once a directive has other sources", () => {
  assert.equal(
    policy({ directives: { "frame-src": ["'none'"] }, routes: [{ match: "a.html", directives: { "frame-src": ["https://x.example"] } }] }, "a.html"),
    "script-src 'self'; frame-src https://x.example",
  );
});

test("globs: ** crosses folders, * and ? do not", () => {
  const m = (glob, file) => globToRegExp(glob).test(file);
  assert.equal(m("**/404.html", "404.html"), true);
  assert.equal(m("**/404.html", "en/404.html"), true);
  assert.equal(m("*.html", "a/b.html"), false);
  assert.equal(m("blog/*/index.html", "blog/post/index.html"), true);
  assert.equal(m("blog/*/index.html", "blog/a/b/index.html"), false);
  assert.equal(m("p?.html", "p1.html"), true);
  assert.equal(m("a.b.html", "aXb.html"), false);
});

test("parsePolicy reads a policy string back", () => {
  assert.deepEqual([...parsePolicy("script-src 'self' 'sha256-a';  upgrade-insecure-requests ; IMG-SRC data:")], [
    ["script-src", ["'self'", "'sha256-a'"]],
    ["upgrade-insecure-requests", []],
    ["img-src", ["data:"]],
  ]);
});
