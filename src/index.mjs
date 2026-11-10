// static-csp: a hashed Content-Security-Policy <meta> for static sites.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MARKER, scanHtml } from "./html.mjs";
import { ConfigError, configWarnings, describeDifference, directivesFor, resolveConfig, serialisePolicy } from "./policy.mjs";

export { MARKER, hashSource, isJavaScriptUrl, scanHtml, scriptKind } from "./html.mjs";
export { ConfigError, configWarnings, directivesFor, globToRegExp, parsePolicy, resolveConfig, serialisePolicy } from "./policy.mjs";

/** The configuration file names looked for, in order, when none is given. */
export const CONFIG_FILES = ["static-csp.config.json", "static-csp.config.mjs", "static-csp.config.js"];

const sortedUnique = (list) => [...new Set(list)].sort();

/** The <meta> element for a policy string. */
export const metaTag = (policy) => `<meta http-equiv="Content-Security-Policy" content="${policy}" ${MARKER}>`;

/**
 * Works out what one page needs, without changing it.
 * @param {string} html
 * @param {{ config?: object, file?: string }} [options] config from resolveConfig;
 *   file is the page's path relative to the build folder ("/"-separated), for routes
 */
export function planPage(html, { config = resolveConfig(), file = "index.html" } = {}) {
  const scan = scanHtml(html, { styles: config.styles });
  if (!scan.head) return { skipped: true, scan, problems: scan.problems, notes: [], warnings: [] };
  const scriptHashes = sortedUnique(scan.scripts.map((s) => s.hash));
  const styleHashes = config.styles === "hash" ? sortedUnique(scan.styleBlocks.map((s) => s.hash)) : [];
  const policy = serialisePolicy(directivesFor(config, file, { scriptHashes, styleHashes }));
  const problems = [...scan.problems];
  const notes = [];
  if (config.styles === "hash") {
    for (const a of scan.styleAttributes) {
      problems.push({ line: a.line, column: a.column, kind: "style-attribute", message: `style= attribute on ${a.tag}: a CSP Level 2 hash cannot allow it, so a policy with style hashes blocks it; move it into a stylesheet or a class` });
    }
  } else if (config.styles === "report") {
    for (const b of scan.styleBlocks) notes.push({ line: b.line, column: b.column, message: `inline <style> block (its hash would be ${b.hash})` });
    for (const a of scan.styleAttributes) notes.push({ line: a.line, column: a.column, message: `style= attribute on ${a.tag}` });
    notes.sort((x, y) => x.line - y.line || x.column - y.column);
  }
  problems.sort((x, y) => x.line - y.line || x.column - y.column);
  const warnings = scan.foreign.map((m) => ({
    line: m.line,
    column: m.column,
    message: "the page has its own CSP <meta>, which static-csp leaves alone; browsers enforce both policies, so it must allow everything this one does (or move its directives into the configuration and remove it)",
  }));
  return { skipped: false, scan, policy, scriptHashes, styleHashes, problems, notes, warnings };
}

/**
 * Returns the page with its policy written (or rewritten) in place.
 * @param {string} html
 * @param {{ config?: object, file?: string }} [options]
 */
export function applyPolicy(html, options = {}) {
  const plan = planPage(html, options);
  if (plan.skipped) return { ...plan, html, changed: false };
  let out = "";
  let last = 0;
  let shift = 0;
  for (const m of plan.scan.ours) {
    out += html.slice(last, m.start);
    last = m.end;
    if (m.end <= plan.scan.insertAt) shift += m.end - m.start;
  }
  out += html.slice(last);
  const at = plan.scan.insertAt - shift;
  out = out.slice(0, at) + metaTag(plan.policy) + out.slice(at);
  return { ...plan, html: out, changed: out !== html };
}

/**
 * Checks a page's policy against what static-csp would write, without
 * changing it. `issues` lists what is wrong with the policy itself;
 * `problems` lists what no policy could allow.
 * @param {string} html
 * @param {{ config?: object, file?: string }} [options]
 */
export function checkPolicy(html, options = {}) {
  const plan = planPage(html, options);
  if (plan.skipped) return { ...plan, ok: plan.problems.length === 0, issues: [] };
  const { ours, insertAt } = plan.scan;
  const issues = [];
  if (!ours.length) issues.push("no static-csp policy: run static-csp on the build output without --check");
  else {
    if (ours.length > 1) issues.push(`${ours.length} static-csp policies on one page; there should be one`);
    if (ours[0].content !== plan.policy) issues.push(...describeDifference(ours[0].content, plan.policy));
    else if (ours.length === 1 && ours[0].start !== insertAt) {
      issues.push("the policy is not the first element of <head> (after a leading <meta charset>), so anything before it is not covered");
    }
  }
  return { ...plan, ok: issues.length === 0 && plan.problems.length === 0, issues };
}

function* htmlFiles(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(full, base);
    else if (entry.isFile() && /\.html?$/i.test(entry.name)) yield { full, rel: path.relative(base, full).split(path.sep).join("/") };
  }
}

/**
 * Applies (or, with check, verifies) the policy on every .html and .htm file
 * under `dir`. Nothing is written unless every page passes: no problems, and
 * at least config.minPages pages.
 * @param {string} dir
 * @param {{ config?: object, check?: boolean }} [options]
 */
export function processDir(dir, { config = resolveConfig(), check = false } = {}) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ConfigError(`no build output folder at ${dir}`);
  const result = {
    dir,
    check,
    pages: 0,
    excluded: 0,
    skipped: [],
    updated: 0,
    current: 0,
    scripts: 0,
    styles: 0,
    problems: [],
    issues: [],
    notes: [],
    warnings: configWarnings(config).map((message) => ({ file: null, message })),
    tooFewPages: false,
    written: false,
    ok: false,
  };
  const scriptHashes = new Set();
  const styleHashes = new Set();
  const toWrite = [];
  for (const { full, rel } of htmlFiles(dir)) {
    if (config.exclude.some((re) => re.test(rel))) {
      result.excluded += 1;
      continue;
    }
    const html = fs.readFileSync(full, "utf8");
    const page = check ? checkPolicy(html, { config, file: rel }) : applyPolicy(html, { config, file: rel });
    const tag = (list, into) => {
      for (const x of list) into.push({ file: rel, ...x });
    };
    tag(page.problems, result.problems);
    tag(page.notes, result.notes);
    tag(page.warnings, result.warnings);
    if (page.skipped) {
      result.skipped.push(rel);
      continue;
    }
    result.pages += 1;
    for (const h of page.scriptHashes) scriptHashes.add(h);
    for (const h of page.styleHashes) styleHashes.add(h);
    if (check) for (const message of page.issues) result.issues.push({ file: rel, message });
    else if (page.changed) toWrite.push({ full, rel });
    else result.current += 1;
  }
  result.scripts = scriptHashes.size;
  result.styles = styleHashes.size;
  result.tooFewPages = result.pages < config.minPages;
  result.ok = !result.problems.length && !result.issues.length && !result.tooFewPages;
  if (!check && result.ok) {
    for (const { full, rel } of toWrite) {
      const out = applyPolicy(fs.readFileSync(full, "utf8"), { config, file: rel });
      fs.writeFileSync(full, out.html);
      result.updated += 1;
    }
    result.written = toWrite.length > 0;
  }
  return result;
}

/**
 * Loads and validates a configuration file (.json, or a .mjs/.js module
 * whose default export is the configuration). A relative `dir` in the file is
 * resolved against the file's folder. `overrides` (for example the command
 * line's styles and minPages) replace the file's keys before validation.
 * @param {string | null} file null for no file: the defaults plus overrides
 * @param {object} [overrides]
 */
export async function loadConfig(file, overrides = {}) {
  let raw = {};
  let full = null;
  if (file) {
    full = path.resolve(file);
    if (!fs.existsSync(full)) throw new ConfigError(`no configuration file at ${file}`);
    if (/\.json$/i.test(full)) {
      try {
        raw = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch (e) {
        throw new ConfigError(`${file}: ${e.message}`);
      }
    } else {
      raw = (await import(pathToFileURL(full).href)).default;
    }
  }
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  let config;
  try {
    config = resolveConfig(raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw, ...defined } : raw);
  } catch (e) {
    if (e instanceof ConfigError && file) throw new ConfigError(`${file}: ${e.message}`);
    throw e;
  }
  if (config.dir && full) config.dir = path.resolve(path.dirname(full), config.dir);
  return config;
}

/** The first configuration file in `cwd` named in CONFIG_FILES, or null. */
export function findConfig(cwd = process.cwd()) {
  for (const name of CONFIG_FILES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
