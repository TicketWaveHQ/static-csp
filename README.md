# static-csp

A strict script policy for static sites, without `'unsafe-inline'`. `static-csp` runs on your build output, hashes every inline script on each page, and writes a `<meta http-equiv="Content-Security-Policy">` at the top of that page's `<head>`. The build fails, with file, line and column, on anything a hash cannot allow: inline event handlers (`onclick=`) and `javascript:` URLs.

It is a zero-dependency Node.js command and ES module. It works on any folder of HTML: Astro, Next.js static export, Eleventy, Hugo, or hand-written pages.

**Who it is for.** Anyone who deploys prerendered HTML and wants inline scripts governed by hash rather than allowed wholesale. That includes hosts that cannot send headers (GitHub Pages), hosts whose header policy has to keep `'unsafe-inline'` for other routes, and sites whose templates carry a few inline scripts: a theme switch that must run before paint, an analytics snippet, an import map. It is not for HTML rendered per request (give that a per-request nonce from the server), and it cannot help with third-party tags that inject inline scripts at runtime.

## 60-second start

```sh
npm install --save-dev github:TicketWaveHQ/static-csp
# or: pnpm add -D github:TicketWaveHQ/static-csp
```

Run it after your build, in `package.json`:

```json
{
  "scripts": {
    "build": "astro build && static-csp dist"
  }
}
```

Use your generator's output folder: `dist` for Astro, `out` for a Next.js static export, `_site` for Eleventy, `public` for Hugo. With a server adapter, point it at the folder that holds the prerendered pages.

Add the hosts your pages load scripts from, and anything else you want in the policy, in `static-csp.config.json` next to `package.json`:

```json
{
  "dir": "dist",
  "directives": {
    "script-src": ["https://stats.example.com"],
    "connect-src": ["'self'", "https://stats.example.com"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"]
  }
}
```

In CI, verify the final output without writing to it:

```sh
npx --no-install static-csp dist --check
```

(The npm package is not published yet, so a plain `npx static-csp` would look for a different package on the registry. `--no-install` uses the copy in your `node_modules`.)

## How it works

A Content Security Policy that allows `'unsafe-inline'` scripts lets any injected `<script>` run. The usual cure is a nonce, a random value that the server puts in the policy and on each script it trusts. A static page is one file served unchanged to every visitor, so a nonce written at build time is public and protects nothing. A hash does work: the policy lists the SHA-256 of each inline script it allows, and the browser runs an inline script only if its text hashes to one of them.

For each `.html` and `.htm` file under the folder, `static-csp`:

1. **Finds the inline scripts a browser would run.** It reads the page with the HTML tokeniser's rules, so comments, `<noscript>`, `<textarea>`, `<title>` and `<style>` contents are not mistaken for markup. A script counts if its `type` is empty or missing, a JavaScript MIME type, `module`, `importmap` or `speculationrules`, as the HTML Standard defines them; all of these are subject to the policy. Data blocks (`application/ld+json`, `application/json`, templates) are never run, so they are not hashed. Scripts with a `src` are covered by the policy's sources (`'self'`, hosts), not by hashes.
2. **Hashes each one from the final bytes**, after turning CRLF and CR into LF as the browser's parser does. Because the hash comes from the built file, it cannot drift from what is served.
3. **Refuses what no hash can allow.** An attribute named `on` plus letters, on any element (`<script src onload>` included), and a `javascript:` URL in `href`, `src`, `action`, `formaction`, `xlink:href` or `data`, however it is written (`java&#x73;cript:`, leading spaces, embedded tabs). If any page has one, nothing is written and the command exits 1.
4. **Writes the policy first in `<head>`**, before anything it governs. If the first element in `<head>` is `<meta charset>` (or `<meta http-equiv="Content-Type">`), the policy goes straight after it, so the encoding declaration stays within the first 1024 bytes where browsers look for it.
5. **Marks its own `<meta>`** with a `data-static-csp` attribute. A second run replaces it, so running twice changes nothing and an edited page gets fresh hashes. A CSP `<meta>` that someone else wrote is left in place, with a warning.

Files with no `<head>` start tag (search-engine verification files, fragments) are left alone and listed. If fewer pages than `minPages` are found, the command fails and writes nothing: that usually means it was pointed at the wrong folder and would otherwise protect nothing while reporting success.

Browsers enforce every policy a page carries. A `<meta>` policy and a header policy are both applied, and a script has to pass both. That is what makes the layered setup in [Pairing with host headers](#pairing-with-host-headers) work: the header can stay permissive while the `<meta>` takes `'unsafe-inline'` away from scripts.

## Configuration

`static-csp` looks for `static-csp.config.json`, `static-csp.config.mjs` or `static-csp.config.js` in the current folder, or takes `--config <file>`. A `.mjs` or `.js` file default-exports the same object. Unknown keys are an error, so a typo does not silently do nothing.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | string | none | The build output folder, relative to the configuration file. A folder on the command line wins. |
| `minPages` | whole number | `1` | Fail, and write nothing, if fewer pages with a `<head>` are found. Set it near your site's real page count. |
| `styles` | `"ignore"`, `"report"`, `"hash"` | `"ignore"` | What to do about inline styles. See [Styles](#styles). |
| `exclude` | glob or globs | `[]` | Files, relative to `dir`, to leave untouched. Excluded pages get no policy. |
| `directives` | object | `{}` | Directive names to sources, as an array or a space-separated string. |
| `routes` | array | `[]` | `{ "match": glob or globs, "directives": { ... } }`: extra sources for the pages that match. |
| `$comment` | any | | Ignored; for notes in JSON. |

**How sources are merged.** Each page's policy is built in order from the defaults (`script-src 'self'`, plus `style-src 'self'` when `styles` is `"hash"`), then `directives`, then every route whose `match` fits the page, in order. Each source is kept once (quoted keywords such as `'self'` are compared without regard to case). The page's script hashes are added to `script-src`, and to `script-src-elem` if you set one; with `styles: "hash"`, style hashes go into `style-src` (and `style-src-elem`). `'none'` is dropped from a directive that ends up with other sources, since it only means something alone. A directive with no sources, such as `"upgrade-insecure-requests": []`, is written on its own.

**Globs** match paths relative to the build folder, with `/` between folders: `**` crosses folders, `*` and `?` do not. `checkout/**` matches `checkout/index.html` and `checkout/step/2.html`; `**/404.html` matches `404.html` and `en/404.html`. A leading `/` is ignored.

**Refused in configuration** (exit 2, with the key named):

- `frame-ancestors`, `report-uri` and `sandbox`: the CSP specification says a `<meta>` policy ignores them. Send them as a header.
- `'unsafe-inline'` in `script-src`, `script-src-elem` or `script-src-attr`. Browsers ignore it once a policy lists a hash, and on a page with no inline scripts to hash it would let any injected script run.
- `'unsafe-hashes'` in those directives: it exists to allow inline event handlers by hash, which this tool refuses (see [Refusals](#refusals)).
- Nonces (`'nonce-...'`), for the reason in [How it works](#how-it-works).
- Sources containing spaces, `;`, `,`, `"`, `<`, `>` or `&`, which would break the policy or the attribute it sits in.
- With `styles: "hash"`, `'unsafe-inline'` in `style-src`, which hashes would cancel.

`'strict-dynamic'` is allowed but warned about: it makes browsers ignore `'self'` and host sources, so `<script src>` tags in the HTML are blocked unless a hashed script loads them.

Example configurations are in [`examples/configs`](examples/configs): a policy layered on a header that still allows `'unsafe-inline'`, a complete policy for a host that sends no headers, and a payment provider's sources on its checkout pages only.

### Styles

- `"ignore"` (the default): styles are not touched. The policy has no `style-src` unless you configure one, so your host's style rules apply.
- `"report"`: every inline `<style>` block and `style=` attribute is listed as a note, with its line and the hash a `<style>` block would need. Nothing fails. Use it to see how far you are from a strict style policy.
- `"hash"`: `<style>` blocks are hashed into `style-src`, and every non-empty `style=` attribute is refused. A CSP Level 2 hash can allow a `<style>` element but not a `style=` attribute, and a policy that lists style hashes blocks the attributes. (CSP Level 3's `'unsafe-hashes'` can allow attributes by hash; this tool does not write it.)

Changing a style from script through the CSSOM (`element.style.color = "red"`) is not governed by `style-src`; `element.setAttribute("style", ...)` is.

## Command line

```text
$ static-csp --help
Usage: static-csp [dir] [options]

Writes a Content-Security-Policy <meta> into every .html page under dir,
listing the SHA-256 of each inline script on that page.

Options:
  -c, --config <file>   configuration file (default: static-csp.config.json,
                        .mjs or .js in the current folder, if there is one)
      --check           verify every page's policy without writing; exit 1 if
                        any is missing or out of date
      --min-pages <n>   fail if fewer than n pages are found (default 1)
      --styles <mode>   ignore (default), report, or hash
  -h, --help            show this help
  -v, --version         show the version

Exit codes: 0 done, 1 a page fails, 2 usage or configuration error.
```

Command-line options override the configuration file. Diagnostics go to standard error as `file:line:column: error: message`, a format many editors and terminals turn into links; the one-line summary goes to standard output.

| Exit code | Meaning |
| --- | --- |
| `0` | Every page passed (and, without `--check`, was written). |
| `1` | A page was refused, a policy is missing or out of date (`--check`), or too few pages were found. Nothing was written. |
| `2` | Usage or configuration error, or the folder does not exist. |

### `--check`

`--check` works out what each page's policy should be and compares it with what is there, writing nothing. It fails if a page has no policy, more than one, a policy whose hashes or sources differ from what the page and the configuration need, or a policy that is not first in `<head>`. It says which: for example, an inline script whose hash is missing (the browser would block it), hashes that match nothing, or a source the configuration no longer lists.

Run it as the last step before deploying, after anything else that touches HTML, or in a separate CI job against the build artefact:

```yaml
- run: npm run build                              # runs static-csp
- run: npx --no-install static-csp dist --check   # the output still matches
```

## Refusals

An inline event handler or a `javascript:` URL is code in an attribute. A hash cannot allow it under CSP Level 2. CSP Level 3's `'unsafe-hashes'` can, but it allows that handler's text on any element, including one an attacker injects, which is why the keyword says unsafe. So the page would ship with a handler that silently stops working, and `static-csp` fails the build instead. The fix is to move the code into a script:

```html
<!-- Refused -->
<button type="button" onclick="addToBasket(42)">Add to basket</button>
<a href="javascript:history.back()">Back</a>

<!-- Allowed -->
<button type="button" class="add" data-product="42">Add to basket</button>
<button type="button" id="back">Back</button>
<script type="module">
  for (const b of document.querySelectorAll(".add")) b.addEventListener("click", () => addToBasket(b.dataset.product));
  document.getElementById("back").addEventListener("click", () => history.back());
</script>
```

The new script is inline, so it is hashed like any other. Any attribute named `on` followed by letters is treated as a handler, including on custom elements; rename a custom attribute that happens to look like one.

## Pairing with host headers

When you can send a response header, send one: it can do things a `<meta>` cannot (see [Limits](#limits)). The two combine well, because browsers enforce both policies and a resource must pass each.

**Split by what each can do.** Let the header carry `frame-ancestors`, `sandbox` where you need it, and reporting, plus any directives you prefer to keep there; let the `<meta>` carry `script-src` with its hashes. If the header has no `script-src` (and no `default-src`), there is nothing to keep in step.

**If the header must keep a `script-src`** (for example, because server-rendered routes share it with `'unsafe-inline'` or a nonce), list every script source it allows, less `'unsafe-inline'` and nonces, in the configuration too. A host the header allows but the `<meta>` leaves out is blocked. [`examples/configs/layered-on-a-header.json`](examples/configs/layered-on-a-header.json) is set up this way. A unit test that reads your host's header file and compares it with the configuration keeps the two in step.

The header for the split above, on a few common hosts:

Netlify or Cloudflare Pages, a `_headers` file in the output folder:

```text
/*
  Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'
```

`vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [{ "key": "Content-Security-Policy", "value": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" }]
    }
  ]
}
```

```nginx
# nginx (an add_header inside a location replaces the server's add_header lines)
add_header Content-Security-Policy "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" always;
```

```apache
# Apache, with mod_headers
Header always set Content-Security-Policy "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
```

GitHub Pages cannot send custom headers, so there the `<meta>` is the whole policy: see [`examples/configs/only-policy.json`](examples/configs/only-policy.json), and the limits below.

## Limits

### Of any `<meta>` policy

- **No `frame-ancestors`, `report-uri` or `sandbox`.** The CSP specification has browsers ignore them in a `<meta>`, so a `<meta>` cannot stop other sites framing yours (clickjacking). `X-Frame-Options` is ignored in a `<meta>` too. Only a header can do this.
- **No report-only mode.** `Content-Security-Policy-Report-Only` is not supported in a `<meta>`, so you cannot trial a policy on real traffic without enforcing it. Test on a preview build first.
- **No violation reports in practice.** `report-uri` is ignored, and `report-to` names an endpoint that only a response header (`Reporting-Endpoints`) can define.
- **It covers only what comes after it**, and only in `<head>`. That is why it is written first.
- **HTML pages only.** Images, PDFs, JSON and SVG files opened directly get no policy from it; an SVG opened on its own can run script. A worker script gets its policy from its own response, not from the page. A header covers all of these.
- **It is part of the page.** Anything that rewrites HTML after `static-csp` (a minifier that touches inline scripts, a CDN feature that injects its own scripts or rewrites markup) can break the hashes. A header arrives before the page and is not affected. Run `static-csp` last, and `--check` the final output.
- **It can only tighten.** A `<meta>` cannot relax a header's policy; each policy is enforced on its own.

So: a header is better wherever you can send one, because it covers framing, reporting, report-only rollout and non-HTML responses. The `<meta>` earns its place where the header cannot be strict about scripts, or where there is no header at all.

### Of this tool

- **Scripts created at runtime** with inline text (as some tag managers do) are not in the HTML, so they are not hashed and will be blocked. Load them from a file covered by a source.
- **`eval`, `new Function` and WebAssembly compilation** need `'unsafe-eval'` or `'wasm-unsafe-eval'`; add them in the configuration if your code needs them.
- **It scans, it does not parse.** It follows the tokeniser's rules for comments, raw text and attributes, not the full tree builder. A `<script>` inside inline `<svg>` is hashed as written, so one that uses character references or CDATA will not match. The legacy `<!--<script>` double-escaped form inside a script is not followed. Scripts inside an `<iframe srcdoc>` (which inherits the page's policy) are not hashed.
- **Pages need an explicit `<head>` start tag**, which every generator named above writes. Files are read as UTF-8, and symbolic links are not followed.
- **SHA-256 only**, which every browser that supports hashes accepts.
- **Prerendered pages only.** Server-rendered responses should get a nonce per request from the server.

## Worked example

[`examples/basic`](examples/basic) is a small hand-written two-page site with a configuration file. These commands and their output are from a real run (the `csp` function stands in for the installed command):

```sh
$ csp() { node /path/to/static-csp/bin/static-csp.mjs "$@"; }
$ cp -R examples/basic /tmp/basic && cd /tmp/basic
```

Before the policy is written, `--check` fails on both pages:

```text
$ csp --check
dist/about/index.html: error: no static-csp policy: run static-csp on the build output without --check
dist/index.html: error: no static-csp policy: run static-csp on the build output without --check
static-csp: 2 pages of 2 with a missing or out-of-date policy
```

Exit code 1. Then write it, and check again (exit code 0 for both):

```text
$ csp
static-csp: dist: 2 pages, 2 distinct inline scripts; 2 updated, 0 already current
$ csp --check
static-csp: every policy is current in dist (2 pages, 2 distinct inline scripts)
```

The configuration was found in the current folder, and its `dir` and `minPages` (2) applied. The top of `dist/index.html` now reads:

```html
<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'self' https://stats.example.com 'sha256-F165ftWoMDodfyb4AS0p3leS4rB6RZ1btiS+/ehz8nc=' 'sha256-o356ujdM2LFW76i43B20XYlvHPD/0qZpYltsL5GEVd0='; connect-src 'self' https://stats.example.com; object-src 'none'; base-uri 'self'" data-static-csp>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Example Bakery</title>
```

The two hashes are the theme script in `<head>` and the click handler script at the end of `<body>`; the JSON-LD block is not hashed. The first hash can be reproduced without this tool:

```text
$ printf '%s' 'document.documentElement.dataset.theme = localStorage.getItem("theme") || "light";' | openssl dgst -sha256 -binary | openssl base64
F165ftWoMDodfyb4AS0p3leS4rB6RZ1btiS+/ehz8nc=
```

`--styles report` shows what a strict style policy would have to deal with (exit code 0):

```text
$ csp --styles report
dist/about/index.html:8:3: note: inline <style> block (its hash would be 'sha256-iimqC2GwEx//wO8KJFt5FerjBAP9OOY1vwizFOgV32s=')
dist/about/index.html:12:21: note: style= attribute on <div class="team" style="margin-top: 2rem">
static-csp: dist: 2 pages, 2 distinct inline scripts; 0 updated, 2 already current
```

[`examples/refusal`](examples/refusal) has a handler and a `javascript:` link. It fails with exit code 1 and is left unchanged:

```text
$ cp -R examples/refusal /tmp/refusal && cd /tmp/refusal
$ csp dist
dist/index.html:8:25: error: inline event handler onclick= on <button type="button" onclick="addToBasket(42)">: no hash can allow it; attach it from a script with addEventListener
dist/index.html:9:6: error: javascript: URL in href= on <a href="javascript:history.back()">: no hash can allow it; use a real URL, or a button with a listener
static-csp: 2 problems that no hash can allow; nothing was written
```

## Using it from code

```js
import { applyPolicy, checkPolicy, loadConfig, processDir, resolveConfig } from "@ticketwavehq/static-csp";

const config = await loadConfig("static-csp.config.json"); // or resolveConfig({ directives: { ... } })
const result = processDir("dist", { config });               // { ok, pages, scripts, problems, ... }
if (!result.ok) process.exit(1);

const page = applyPolicy(html, { config, file: "about/index.html" }); // { html, changed, policy, problems, ... }
const check = checkPolicy(page.html, { config, file: "about/index.html" }); // { ok, issues, problems, ... }
```

| Export | What it does |
| --- | --- |
| `processDir(dir, { config, check })` | Runs on a folder, as the command does, and returns a summary. Writes only if every page passes. |
| `applyPolicy(html, { config, file })` | Returns one page with its policy written. `file` is the page's path in the build folder, for `routes`. |
| `checkPolicy(html, { config, file })` | Compares a page's policy with what it should be; `issues` says how it differs. |
| `planPage(html, { config, file })` | What a page needs (policy, hashes, problems, notes, warnings), without changing it. |
| `scanHtml(html, { styles })` | The scanner's findings: inline scripts and styles, refusals, `<head>`, CSP `<meta>` elements. |
| `hashSource(text)` | The CSP hash source for a script or style text, for example `'sha256-...'`. |
| `loadConfig(file, overrides)`, `resolveConfig(raw)` | Read and validate a configuration; both throw `ConfigError` with the key named. |
| `directivesFor(config, file, hashes)`, `serialisePolicy(map)`, `parsePolicy(text)` | Build, write and read policy strings. |

## Development

```sh
npm test    # node --test: offline, no dependencies to install
```

Node.js 20 or later. See [CONTRIBUTING.md](CONTRIBUTING.md); report security issues as described in [SECURITY.md](SECURITY.md).

`static-csp` began as a build step on a production Astro site, run on every deploy, and was generalised for any static output.

## Licence

MIT. See [LICENSE](LICENSE).

Maintained by [TicketWave HQ](https://ticketwavehq.com), a UK company (Companies House 17143167).
