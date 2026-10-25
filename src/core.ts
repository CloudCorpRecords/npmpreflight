/**
 * npmpreflight core: audit a package directory before npm publish.
 *
 * The shipped file set is resolved statically: the files field when one
 * is present (literal files, directories walked recursively, and a
 * simple glob subset), otherwise everything in the directory except
 * node_modules, .git, and paths matched by a simple .npmignore subset.
 * package.json, README, and LICENSE are always included when present,
 * matching npm behaviour. This is a static approximation of npm pack,
 * not a byte-exact reproduction of it.
 *
 * Secret scanning never records the matched text. A finding carries the
 * rule id, the file, the line, and the pattern id as its only evidence.
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Finding, Report, Severity } from "./types.js";

export const VERSION = "0.1.0";
export const CLEAN_VERDICT = "READY";
export const FIX_VERDICT = "FIX-FIRST";

export const MAX_FILES = 5000;
export const MAX_SCAN_BYTES = 512 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

const REQUIRED_FIELDS = ["name", "version", "license", "description"] as const;

const ALWAYS_INCLUDED_RE = /^(?:package\.json|readme(?:\.[^/]*)?|licen[cs]e(?:\.[^/]*)?)$/i;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function stripDotSlash(p: string): string {
  let out = p.trim();
  while (out.startsWith("./")) out = out.slice(2);
  return out.replace(/^\/+/, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return true;
}

/* ------------------------------------------------------------------ */
/* .npmignore: simple subset                                           */
/* ------------------------------------------------------------------ */

interface IgnoreRule {
  pattern: string;
  isDir: boolean;
  hasSlash: boolean;
}

/**
 * Parse the supported .npmignore subset: blank lines and # comments are
 * skipped, plain lines match a file name at any depth or an exact
 * relative path, and lines ending in / match a directory. Globs,
 * negations, and character classes are not supported.
 */
function parseNpmignore(root: string): IgnoreRule[] {
  const path = join(root, ".npmignore");
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.replace(/^\/+/, "");
    const isDir = cleaned.endsWith("/");
    const pattern = isDir ? cleaned.replace(/\/+$/, "") : cleaned;
    if (!pattern) continue;
    rules.push({ pattern, isDir, hasSlash: pattern.includes("/") });
  }
  return rules;
}

function matchesIgnore(rel: string, rules: IgnoreRule[]): boolean {
  const segments = rel.split("/");
  for (const rule of rules) {
    if (rule.isDir) {
      if (rule.hasSlash) {
        if (rel === rule.pattern || rel.startsWith(`${rule.pattern}/`)) return true;
      } else if (segments.includes(rule.pattern)) {
        return true;
      }
      continue;
    }
    if (rule.hasSlash) {
      if (rel === rule.pattern || rel.startsWith(`${rule.pattern}/`)) return true;
    } else if (basename(rel) === rule.pattern) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Simple glob subset for files entries                                */
/* ------------------------------------------------------------------ */

function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  out += "$";
  return new RegExp(out);
}

/* ------------------------------------------------------------------ */
/* Shipped file set resolution                                         */
/* ------------------------------------------------------------------ */

interface ShippedFile {
  rel: string;
  abs: string;
  size: number;
}

interface Collected {
  files: ShippedFile[];
  filesSeen: number;
  truncated: boolean;
}

class Collector {
  private byRel = new Map<string, ShippedFile>();
  private seen = new Set<string>();
  truncated = false;

  get filesSeen(): number {
    return this.seen.size;
  }

  get files(): ShippedFile[] {
    return [...this.byRel.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }

  has(rel: string): boolean {
    return this.byRel.has(rel);
  }

  remove(rel: string): void {
    this.byRel.delete(rel);
  }

  removeUnder(dirRel: string): void {
    for (const rel of [...this.byRel.keys()]) {
      if (rel === dirRel || rel.startsWith(`${dirRel}/`)) this.byRel.delete(rel);
    }
  }

  /** Count a distinct candidate file, then ship it unless the cap hit. */
  consider(rel: string, abs: string): void {
    if (this.seen.has(rel)) return;
    this.seen.add(rel);
    if (this.byRel.size >= MAX_FILES) {
      this.truncated = true;
      return;
    }
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      return;
    }
    this.byRel.set(rel, { rel, abs, size });
  }

  /** Walk a directory recursively in sorted order. */
  walk(dirAbs: string, dirRel: string, opts: { ignore?: IgnoreRule[] } = {}): void {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const abs = join(dirAbs, entry.name);
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        this.walk(abs, rel, opts);
      } else if (entry.isFile()) {
        const always = dirRel === "" && ALWAYS_INCLUDED_RE.test(entry.name);
        if (!always && opts.ignore && matchesIgnore(rel, opts.ignore)) continue;
        this.consider(rel, abs);
      }
      // Symlinks and special files are not followed or shipped.
    }
  }
}

function collectShipped(root: string, pkg: Record<string, unknown>): Collected {
  const collector = new Collector();
  const filesField = Array.isArray(pkg["files"]) ? (pkg["files"] as unknown[]) : undefined;

  if (filesField) {
    for (const rawEntry of filesField) {
      if (typeof rawEntry !== "string") continue;
      let entry = stripDotSlash(rawEntry);
      if (!entry) continue;
      const negated = entry.startsWith("!");
      if (negated) entry = stripDotSlash(entry.slice(1));
      if (!entry) continue;

      if (entry.includes("*") || entry.includes("?")) {
        const re = globToRegExp(entry);
        if (negated) {
          for (const f of collector.files) {
            if (re.test(f.rel)) collector.remove(f.rel);
          }
        } else {
          // Walk the whole tree once per glob entry, matching paths.
          const before = new Set(collector.files.map((f) => f.rel));
          const walker = new Collector();
          walker.walk(root, "");
          for (const f of walker.files) {
            if (re.test(f.rel)) collector.consider(f.rel, f.abs);
          }
          void before;
        }
        continue;
      }

      const clean = entry.replace(/\/+$/, "");
      const abs = join(root, clean);
      if (negated) {
        collector.remove(clean);
        collector.removeUnder(clean);
        continue;
      }
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        collector.walk(abs, clean);
      } else if (st.isFile()) {
        collector.consider(clean, abs);
      }
    }
  } else {
    const ignore = parseNpmignore(root);
    collector.walk(root, "", { ignore });
  }

  // Always included, even when the files field or .npmignore omits them.
  let rootEntries: string[] = [];
  try {
    rootEntries = readdirSync(root).sort();
  } catch {
    rootEntries = [];
  }
  for (const name of rootEntries) {
    if (!ALWAYS_INCLUDED_RE.test(name)) continue;
    const abs = join(root, name);
    try {
      if (statSync(abs).isFile()) collector.consider(name, abs);
    } catch {
      continue;
    }
  }

  return { files: collector.files, filesSeen: collector.filesSeen, truncated: collector.truncated };
}

/* ------------------------------------------------------------------ */
/* Secret scanning                                                     */
/* ------------------------------------------------------------------ */

interface SecretPattern {
  id: string;
  make: () => RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { id: "private-key-block", make: () => /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: "aws-access-key-id", make: () => /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "github-pat-classic", make: () => /\bghp_[A-Za-z0-9]{36,}\b/g },
  { id: "github-pat-fine-grained", make: () => /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: "api-key-sk", make: () => /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
];

const GENERIC_ASSIGNMENT: SecretPattern = {
  id: "generic-api-key-assignment",
  make: () =>
    /(?:\bapi[_-]?key\b|\bapikey\b|\bsecret[_-]?key\b|\baccess[_-]?token\b|\bauth[_-]?token\b)\s*[:=]\s*["'][^"'\r\n\s]{16,}["']/gi,
};

/** Read at most MAX_SCAN_BYTES from the head of a file. */
function readHead(abs: string, size: number): Buffer {
  const cap = Math.min(size, MAX_SCAN_BYTES);
  if (cap <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(cap);
  let fd: number;
  try {
    fd = openSync(abs, "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    readSync(fd, buf, 0, cap, 0);
  } catch {
    return Buffer.alloc(0);
  } finally {
    closeSync(fd);
  }
  return buf;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function scanFile(file: ShippedFile, findings: Finding[]): void {
  const head = readHead(file.abs, file.size);
  if (head.length === 0) return;
  if (head.includes(0)) return; // Binary file: not scanned as text.
  const text = head.toString("utf8");
  const seen = new Set<string>();
  const specificLines = new Set<number>();

  for (const pattern of SECRET_PATTERNS) {
    const re = pattern.make();
    for (const match of text.matchAll(re)) {
      const line = lineOf(text, match.index ?? 0);
      specificLines.add(line);
      const key = `${pattern.id}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        rule: "SECRET-LEAK",
        severity: "high",
        file: file.rel,
        line,
        message: `Shipped file matches the secret pattern ${pattern.id}. Remove the credential from the package and rotate it if it was ever real.`,
        evidence: pattern.id,
      });
    }
  }

  // A generic assignment on a line already flagged by a specific
  // pattern would only duplicate the same leak, so it is skipped there.
  const genericRe = GENERIC_ASSIGNMENT.make();
  for (const match of text.matchAll(genericRe)) {
    const line = lineOf(text, match.index ?? 0);
    if (specificLines.has(line)) continue;
    const key = `${GENERIC_ASSIGNMENT.id}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      rule: "SECRET-LEAK",
      severity: "high",
      file: file.rel,
      line,
      message: `Shipped file matches the secret pattern ${GENERIC_ASSIGNMENT.id}. Remove the credential from the package and rotate it if it was ever real.`,
      evidence: GENERIC_ASSIGNMENT.id,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Main check                                                          */
/* ------------------------------------------------------------------ */

export function runCheck(target: string): Report {
  const root = resolve(target);
  const pkgPath = join(root, "package.json");

  let pkgText: string;
  try {
    pkgText = readFileSync(pkgPath, "utf8");
  } catch {
    // A target that is itself a package.json file is accepted too.
    try {
      if (basename(root) === "package.json") {
        return runCheck(dirname(root));
      }
    } catch {
      // Fall through to the clear error below.
    }
    throw new Error(`package.json not found at ${pkgPath}: ${target} is not a package directory with a readable package.json`);
  }
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(pkgText);
    if (!isRecord(parsed)) throw new Error("top level is not an object");
    pkg = parsed;
  } catch (err) {
    throw new Error(`package.json at ${pkgPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { files, filesSeen, truncated } = collectShipped(root, pkg);
  const shippedRels = new Set(files.map((f) => f.rel));
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const findings: Finding[] = [];

  // Required fields.
  for (const field of REQUIRED_FIELDS) {
    if (!isPresent(pkg[field])) {
      findings.push({
        rule: "MISSING-FIELD",
        severity: "high",
        file: "package.json",
        message: `package.json is missing the ${field} field. npm publish needs it, and registries and tooling read it as the package identity.`,
        evidence: field,
      });
    }
  }

  // Bin targets must be in the shipped set.
  const binPaths: string[] = [];
  const bin = pkg["bin"];
  if (typeof bin === "string") binPaths.push(bin);
  else if (isRecord(bin)) {
    for (const v of Object.values(bin)) if (typeof v === "string") binPaths.push(v);
  }
  for (const binPath of [...binPaths].sort()) {
    const rel = stripDotSlash(binPath);
    if (!shippedRels.has(rel)) {
      findings.push({
        rule: "BIN-MISSING",
        severity: "high",
        file: "package.json",
        message: `bin target ${rel} is not in the shipped file set. The published package would install a command that does not exist.`,
        evidence: rel,
      });
    }
  }

  // The main entry point must be in the shipped set.
  if (typeof pkg["main"] === "string" && pkg["main"].trim()) {
    const rel = stripDotSlash(pkg["main"]);
    if (!shippedRels.has(rel)) {
      findings.push({
        rule: "MAIN-MISSING",
        severity: "high",
        file: "package.json",
        message: `main entry ${rel} is not in the shipped file set. Consumers would fail to load the published package.`,
        evidence: rel,
      });
    }
  }

  // Secret scan over the shipped set.
  for (const file of files) scanFile(file, findings);

  // Size checks.
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      findings.push({
        rule: "OVERSIZE",
        severity: "medium",
        file: file.rel,
        message: `Shipped file is ${file.size} bytes, over the ${MAX_FILE_BYTES} byte per-file limit. Large payloads usually belong in a release asset, not the npm tarball.`,
        evidence: `${file.size} bytes`,
      });
    }
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    findings.push({
      rule: "OVERSIZE",
      severity: "medium",
      message: `Total shipped size is ${totalBytes} bytes, over the ${MAX_TOTAL_BYTES} byte limit. Trim the files field or split the payload out of the package.`,
      evidence: `${totalBytes} bytes`,
    });
  }

  // Scoped packages need an explicit public publishConfig.
  const name = typeof pkg["name"] === "string" ? pkg["name"] : "";
  if (name.startsWith("@")) {
    const pc = isRecord(pkg["publishConfig"]) ? pkg["publishConfig"] : undefined;
    if (pc?.["access"] !== "public") {
      findings.push({
        rule: "SCOPED-NO-PUBLISHCONFIG",
        severity: "medium",
        file: "package.json",
        message: `Scoped package ${name} does not set publishConfig.access to public. A first publish would default to restricted access and fail or stay private.`,
        evidence: name,
      });
    }
  }

  // README presence.
  const hasReadme = files.some((f) => /^readme(?:\.[^/]*)?$/i.test(basename(f.rel)));
  if (!hasReadme) {
    findings.push({
      rule: "NO-README",
      severity: "low",
      message: "No README file is in the shipped set. The registry page and the installed package would have no usage documentation.",
    });
  }

  // Engines declaration.
  if (!isPresent(pkg["engines"])) {
    findings.push({
      rule: "NO-ENGINES",
      severity: "info",
      file: "package.json",
      message: "package.json declares no engines range. Consumers and CI cannot tell which Node versions the package supports.",
    });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.file ?? "") .localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );

  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;

  const verdict = bySeverity.high > 0 ? FIX_VERDICT : CLEAN_VERDICT;
  const counts: Record<string, number> = {
    files: files.length,
    bytes: totalBytes,
    findings: findings.length,
    high: bySeverity.high,
    medium: bySeverity.medium,
    low: bySeverity.low,
    info: bySeverity.info,
    filesSeen,
    truncated: truncated ? 1 : 0,
    maxFiles: MAX_FILES,
    maxScanBytes: MAX_SCAN_BYTES,
  };
  const summary =
    `${files.length} shipped file(s), ${totalBytes} byte(s), ${findings.length} finding(s) ` +
    `(${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.low} low, ${bySeverity.info} info). ` +
    (verdict === CLEAN_VERDICT ? "No high-severity findings." : "High-severity findings must be fixed before publishing.");

  return {
    tool: "npmpreflight",
    version: VERSION,
    target,
    verdict,
    counts,
    findings,
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function renderReport(report: Report): string {
  const out: string[] = [];
  out.push(`npmpreflight check ${report.target}: ${report.verdict}`);
  out.push(
    `  files: ${report.counts["files"] ?? 0}, bytes: ${report.counts["bytes"] ?? 0}, findings: ${report.counts["findings"] ?? 0} ` +
      `(high: ${report.counts["high"] ?? 0}, medium: ${report.counts["medium"] ?? 0}, low: ${report.counts["low"] ?? 0}, info: ${report.counts["info"] ?? 0})`,
  );
  out.push(`  summary: ${report.summary}`);
  if ((report.counts["truncated"] ?? 0) > 0) {
    out.push(
      `  note: shipped file set cap reached: ${report.counts["filesSeen"] ?? 0} file(s) seen, only the first ${report.counts["maxFiles"] ?? MAX_FILES} (sorted by path within each directory) were shipped and scanned. The remaining files were NOT scanned.`,
    );
  }
  for (const f of report.findings) {
    const where = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "package";
    const evidence = f.evidence ? ` (evidence: ${f.evidence})` : "";
    out.push(`  [${f.severity.toUpperCase()}] ${f.rule} ${where} ${f.message}${evidence}`);
  }
  if (report.verdict === CLEAN_VERDICT) {
    out.push("READY: no high-severity findings in the shipped file set.");
  } else {
    out.push("FIX-FIRST: resolve the high-severity findings before publishing.");
  }
  return out.join("\n");
}
