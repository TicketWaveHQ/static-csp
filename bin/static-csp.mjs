#!/usr/bin/env node
// The static-csp command. Exit codes: 0 done, 1 the pages fail, 2 usage or configuration error.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, findConfig, loadConfig, processDir } from "../src/index.mjs";

const HELP = `Usage: static-csp [dir] [options]

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

Exit codes: 0 done, 1 a page fails, 2 usage or configuration error.`;

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);
const usage = (message) => {
  err(`static-csp: ${message}`);
  err("Run static-csp --help for usage.");
  process.exit(2);
};

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      check: { type: "boolean" },
      "min-pages": { type: "string" },
      styles: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
} catch (e) {
  usage(e.message);
}
const { values, positionals } = args;

if (values.help) {
  out(HELP);
  process.exit(0);
}
if (values.version) {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  out(pkg.version);
  process.exit(0);
}
if (positionals.length > 1) usage(`expected one folder, got ${positionals.length}`);

const minPages = values["min-pages"];
if (minPages !== undefined && !/^\d+$/.test(minPages)) usage("--min-pages takes a whole number");

let config;
try {
  config = await loadConfig(values.config ?? findConfig(), {
    styles: values.styles,
    minPages: minPages === undefined ? undefined : Number(minPages),
  });
} catch (e) {
  if (e instanceof ConfigError) usage(e.message);
  throw e;
}

const dirArg = positionals[0] ?? config.dir;
if (!dirArg) usage("say which folder holds the build output, for example: static-csp dist");
const dir = path.resolve(dirArg);
const shown = path.relative(process.cwd(), dir) || ".";
const where = (x) => `${path.join(shown, x.file)}${x.line ? `:${x.line}:${x.column}` : ""}`;

let result;
try {
  result = processDir(dir, { config, check: Boolean(values.check) });
} catch (e) {
  if (e instanceof ConfigError) usage(e.message);
  throw e;
}

for (const w of result.warnings) err(w.file ? `${where(w)}: warning: ${w.message}` : `static-csp: warning: ${w.message}`);
for (const n of result.notes) err(`${where(n)}: note: ${n.message}`);
for (const p of result.problems) err(`${where(p)}: error: ${p.message}`);
for (const i of result.issues) err(`${where(i)}: error: ${i.message}`);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const extras = [];
if (result.excluded) extras.push(`${plural(result.excluded, "file")} excluded`);
if (result.skipped.length) {
  const names = result.skipped.slice(0, 5).join(", ") + (result.skipped.length > 5 ? ` and ${result.skipped.length - 5} more` : "");
  extras.push(`${plural(result.skipped.length, "file")} with no <head> left alone (${names})`);
}
const tail = extras.length ? `; ${extras.join("; ")}` : "";

if (result.problems.length) {
  err(`static-csp: ${plural(result.problems.length, "problem")} that no hash can allow${values.check ? "" : "; nothing was written"}`);
}
if (result.issues.length) {
  const pages = new Set(result.issues.map((i) => i.file)).size;
  err(`static-csp: ${plural(pages, "page")} of ${result.pages} with a missing or out-of-date policy`);
}
if (result.tooFewPages) {
  err(`static-csp: only ${plural(result.pages, "page")} with a <head> in ${shown}, fewer than the ${config.minPages} expected; is this the build output folder?${values.check ? "" : " Nothing was written."}`);
}
if (!result.ok) process.exit(1);

const counts = `${plural(result.pages, "page")}, ${plural(result.scripts, "distinct inline script")}${config.styles === "hash" ? `, ${plural(result.styles, "distinct inline style")}` : ""}`;
if (values.check) out(`static-csp: every policy is current in ${shown} (${counts})${tail}`);
else out(`static-csp: ${shown}: ${counts}; ${result.updated} updated, ${result.current} already current${tail}`);
