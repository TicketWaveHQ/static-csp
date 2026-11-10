// Configuration, directive merging, and the policy string itself.

/** Directives a browser ignores when the policy arrives in a <meta> element. */
export const META_IGNORED = {
  "frame-ancestors": "a <meta> policy cannot set frame-ancestors; send it as a response header",
  "report-uri": "a <meta> policy cannot set report-uri; send it as a response header",
  sandbox: "a <meta> policy cannot set sandbox; send it as a response header",
};

const STYLE_MODES = ["ignore", "report", "hash"];
const CONFIG_KEYS = new Set(["$comment", "dir", "minPages", "styles", "exclude", "directives", "routes"]);
const SCRIPT_DIRECTIVES = ["script-src", "script-src-elem", "script-src-attr"];
const HASH = /^'sha(?:256|384|512)-[A-Za-z0-9+/_=-]+'$/;
const SOURCE = /^(?:'[A-Za-z0-9+/_=-]+'|[^\s"'`;,<>&\\]+)$/;

export class ConfigError extends Error {}

const fail = (message) => {
  throw new ConfigError(message);
};

/** A list of sources, from an array or a space-separated string. */
function sourcesOf(value, where) {
  let list;
  if (typeof value === "string") list = value.trim() === "" ? [] : value.trim().split(/\s+/);
  else if (Array.isArray(value) && value.every((v) => typeof v === "string")) list = value.map((v) => v.trim()).filter(Boolean);
  else fail(`${where}: sources must be a string or an array of strings`);
  for (const s of list) {
    if (/^'nonce-/i.test(s)) fail(`${where}: ${s}: a nonce in a static file is the same for every visitor, so it protects nothing; this tool uses hashes instead`);
    if (!SOURCE.test(s)) fail(`${where}: ${JSON.stringify(s)} is not a valid source (keywords take single quotes, and a source cannot contain ; , " < > & or spaces)`);
  }
  return list;
}

/** Validates a directives object and returns it as [name, sources[]] pairs. */
function directivesOf(value, where) {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object of directive names to sources`);
  const out = [];
  for (const [rawName, sources] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name)) fail(`${where}: ${JSON.stringify(rawName)} is not a directive name`);
    if (META_IGNORED[name]) fail(`${where}: ${META_IGNORED[name]}`);
    const list = sourcesOf(sources, `${where}.${name}`);
    if (SCRIPT_DIRECTIVES.includes(name)) {
      if (list.some((s) => s.toLowerCase() === "'unsafe-inline'")) {
        fail(`${where}.${name}: 'unsafe-inline' would let any inline script run on a page with none to hash, and is ignored on a page with hashes; leave it out`);
      }
      if (list.some((s) => s.toLowerCase() === "'unsafe-hashes'")) {
        fail(`${where}.${name}: 'unsafe-hashes' is for allowing inline event handlers by hash, which this tool refuses; move handlers into scripts`);
      }
    }
    out.push([name, list]);
  }
  return out;
}

const globList = (value, where) => {
  if (value === undefined) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.every((v) => typeof v === "string" && v.trim() !== "")) fail(`${where} must be a glob or an array of globs`);
  return list.map((g) => g.trim().replace(/^\.?\//, ""));
};

/**
 * Validates a raw configuration object (from JSON or a module) and fills in
 * defaults. Throws ConfigError with a message naming the bad key.
 * @param {object} [raw]
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("the configuration must be an object");
  for (const key of Object.keys(raw)) if (!CONFIG_KEYS.has(key)) fail(`unknown configuration key ${JSON.stringify(key)} (expected one of: ${[...CONFIG_KEYS].filter((k) => k !== "$comment").join(", ")})`);
  const styles = raw.styles ?? "ignore";
  if (!STYLE_MODES.includes(styles)) fail(`styles must be one of ${STYLE_MODES.join(", ")}`);
  const minPages = raw.minPages ?? 1;
  if (!Number.isInteger(minPages) || minPages < 0) fail("minPages must be a whole number, 0 or more");
  if (raw.dir !== undefined && (typeof raw.dir !== "string" || raw.dir.trim() === "")) fail("dir must be a folder path");
  if (raw.routes !== undefined && !Array.isArray(raw.routes)) fail("routes must be an array");
  const routes = (raw.routes ?? []).map((route, n) => {
    const where = `routes[${n}]`;
    if (route === null || typeof route !== "object") fail(`${where} must be an object with "match" and "directives"`);
    for (const key of Object.keys(route)) if (!["match", "directives", "$comment"].includes(key)) fail(`${where}: unknown key ${JSON.stringify(key)}`);
    const match = globList(route.match, `${where}.match`);
    if (!match.length) fail(`${where}.match is required`);
    return { match: match.map(globToRegExp), patterns: match, directives: directivesOf(route.directives, `${where}.directives`) };
  });
  const directives = directivesOf(raw.directives, "directives");
  if (styles === "hash") {
    for (const [name, list] of [...directives, ...routes.flatMap((r) => r.directives)]) {
      if (/^style-src(-elem)?$/.test(name) && list.some((s) => s.toLowerCase() === "'unsafe-inline'")) {
        fail(`${name}: 'unsafe-inline' is ignored once a policy lists style hashes; with styles "hash", leave it out (or use styles "ignore" or "report")`);
      }
    }
  }
  return {
    dir: raw.dir,
    minPages,
    styles,
    exclude: globList(raw.exclude, "exclude").map(globToRegExp),
    directives,
    routes,
  };
}

/** Warnings about a resolved configuration that are legal but probably unintended. */
export function configWarnings(config) {
  const warnings = [];
  const all = [...config.directives, ...config.routes.flatMap((r) => r.directives)];
  if (all.some(([name, list]) => SCRIPT_DIRECTIVES.includes(name) && list.some((s) => s.toLowerCase() === "'strict-dynamic'"))) {
    warnings.push("'strict-dynamic' makes browsers ignore 'self' and host sources, so <script src> tags in the HTML are blocked unless a hashed script loads them");
  }
  return warnings;
}

/**
 * Turns a glob into a regular expression over "/"-separated paths relative
 * to the build folder: ** crosses folders, * and ? do not.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// Keywords ('self') are case-insensitive; a source with a path is not.
const sameSource = (a, b) => (a.startsWith("'") && b.startsWith("'") ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Merges lists of [name, sources] pairs in order, keeping each source once. */
function merge(...groups) {
  const out = new Map();
  for (const group of groups) {
    for (const [name, sources] of group) {
      const list = out.get(name) ?? [];
      for (const s of sources) if (!list.some((x) => sameSource(x, s))) list.push(s);
      out.set(name, list);
    }
  }
  return out;
}

/**
 * The directives for one page: the defaults, then the configuration, then
 * every route that matches the page, then the page's hashes.
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {string} file path relative to the build folder, "/"-separated
 * @param {{ scriptHashes?: string[], styleHashes?: string[] }} hashes
 */
export function directivesFor(config, file, { scriptHashes = [], styleHashes = [] } = {}) {
  const defaults = [["script-src", ["'self'"]]];
  if (config.styles === "hash") defaults.push(["style-src", ["'self'"]]);
  const routes = config.routes.filter((r) => r.match.some((re) => re.test(file))).flatMap((r) => r.directives);
  const merged = merge(defaults, config.directives, routes);
  const add = (names, hashes) => {
    for (const name of names) {
      if (!merged.has(name)) continue;
      const list = merged.get(name);
      for (const h of hashes) if (!list.includes(h)) list.push(h);
    }
  };
  add(["script-src", "script-src-elem"], scriptHashes);
  if (config.styles === "hash") add(["style-src", "style-src-elem"], styleHashes);
  // 'none' only means something on its own.
  for (const [name, list] of merged) if (list.length > 1) merged.set(name, list.filter((s) => s.toLowerCase() !== "'none'"));
  return merged;
}

/** The policy string for a Map of directives. */
export function serialisePolicy(directives) {
  return [...directives].map(([name, list]) => (list.length ? `${name} ${list.join(" ")}` : name)).join("; ");
}

/** Parses a policy string into a Map of directive names to sources. */
export function parsePolicy(policy) {
  const out = new Map();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), sources);
  }
  return out;
}

/**
 * Explains how a policy found on a page differs from the one it should have.
 * @returns {string[]}
 */
export function describeDifference(actual, expected) {
  const a = parsePolicy(actual);
  const e = parsePolicy(expected);
  const notes = [];
  const hashesIn = (policy, names) => new Set(names.flatMap((n) => policy.get(n) ?? []).filter((s) => HASH.test(s)));
  const list = (items) => (items.length > 3 ? `${items.slice(0, 3).join(" ")} and ${items.length - 3} more` : items.join(" "));
  for (const [what, names] of [
    ["script", ["script-src", "script-src-elem"]],
    ["style", ["style-src", "style-src-elem"]],
  ]) {
    const have = hashesIn(a, names);
    const want = hashesIn(e, names);
    const missing = [...want].filter((h) => !have.has(h));
    const extra = [...have].filter((h) => !want.has(h));
    if (missing.length) notes.push(`${missing.length} inline ${what}${missing.length > 1 ? "s" : ""} on the page ${missing.length > 1 ? "are" : "is"} not in the policy and would be blocked: ${list(missing)}`);
    if (extra.length) notes.push(`${extra.length} ${what} hash${extra.length > 1 ? "es" : ""} in the policy ${extra.length > 1 ? "match" : "matches"} nothing on the page: ${list(extra)}`);
  }
  const strip = (policy) => new Map([...policy].map(([n, s]) => [n, s.filter((x) => !HASH.test(x))]));
  const sa = strip(a);
  const se = strip(e);
  const changes = [];
  for (const name of new Set([...sa.keys(), ...se.keys()])) {
    const have = sa.get(name);
    const want = se.get(name);
    if (!have) changes.push(`${name} missing`);
    else if (!want) changes.push(`${name} not in the configuration`);
    else {
      const added = want.filter((s) => !have.includes(s));
      const removed = have.filter((s) => !want.includes(s));
      if (added.length || removed.length) changes.push(`${name}${added.length ? ` needs ${added.join(" ")}` : ""}${removed.length ? `${added.length ? "," : ""} has ${removed.join(" ")} the configuration no longer lists` : ""}`);
    }
  }
  if (changes.length) notes.push(`the policy does not match the configuration: ${changes.join("; ")}`);
  if (!notes.length) notes.push("the policy text differs from what static-csp would write");
  return notes;
}
