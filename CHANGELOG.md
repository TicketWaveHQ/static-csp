# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.0 - 2026-11-10

### Added

- `static-csp` command and ES module, with no dependencies, for Node.js 20 or later.
- SHA-256 hashes of every inline script a browser would run (classic, `module`, `importmap` and `speculationrules`), taken from the built bytes with line endings normalised as the HTML parser does. Data blocks such as JSON-LD are not hashed.
- A `<meta http-equiv="Content-Security-Policy">` written first in `<head>` (after a leading `<meta charset>`), marked `data-static-csp` so that re-runs replace it and running twice changes nothing.
- Refusal, with file, line and column, of inline event handlers and `javascript:` URLs, including encoded forms. Nothing is written if any page is refused.
- `minPages`, so the wrong folder fails the build rather than protecting nothing.
- Configuration file (`static-csp.config.json`, `.mjs` or `.js`) with `directives`, per-path `routes`, `exclude`, `styles` and `dir`; refuses directives a `<meta>` policy ignores, `'unsafe-inline'` in script directives, and nonces.
- `--check`, which verifies every page's policy without writing and explains any difference.
- `--styles report` to list inline styles, and `--styles hash` to hash `<style>` blocks and refuse `style=` attributes.
