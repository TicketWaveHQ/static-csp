# Security policy

## Reporting a vulnerability

Please email **hello@ticketwavehq.com** rather than opening a public issue. The company's disclosure policy is at [ticketwavehq.com/security](https://ticketwavehq.com/security). Include:

- the version (or commit) of static-csp,
- an HTML input, configuration and command that reproduce the problem,
- what you expected and what happened.

We will acknowledge your report, keep you informed as we investigate, and credit you in the release notes if you would like.

## What counts

static-csp exists to write a policy that lets a page's own inline scripts run and nothing else. These are security issues:

- a policy that allows a script it should not (for example, a hash computed from text the browser does not run, or a source the configuration did not ask for);
- an inline event handler, `javascript:` URL or other construct that the scanner misses, so a page passes that a browser would treat differently;
- a configuration or input that makes static-csp write a broken or weakened policy without failing.

A page whose own script is blocked because static-csp hashed it differently from the browser is a bug rather than a vulnerability, since it fails closed, but please report it too.

## Supported versions

Fixes are made on the latest 0.x release.
