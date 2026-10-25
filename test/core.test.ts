/**
 * Core tests for npmpreflight against checked-in fixture packages and
 * generated temp packages. All credential-shaped strings in the
 * fixtures are synthetic test data (an obvious fake token shape or a
 * bare key header line); none of them are real credentials.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck, renderReport, MAX_FILES } from "../src/core.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_TOKEN = "ghp_" + "X".repeat(36);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(name: string): string {
  return join(FIXTURES, name);
}

function totalBytes(root: string, rels: string[]): number {
  return rels.reduce((sum, rel) => sum + statSync(join(root, rel)).size, 0);
}

function writeTempPackage(pkg: Record<string, unknown>, files: Record<string, string | Buffer> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "npmpreflight-test-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const COMPLETE_PKG: Record<string, unknown> = {
  name: "temp-pkg",
  version: "1.0.0",
  description: "A temporary package for tests.",
  license: "MIT",
  main: "index.js",
  engines: { node: ">=20" },
  files: ["index.js"],
};

const BASE_FILES: Record<string, string> = {
  "index.js": "export const ok = true;\n",
  "README.md": "# temp-pkg\n\nTemporary test package.\n",
  LICENSE: "MIT License\n",
};

describe("fixture packages", () => {
  it("pkg-ready is READY with no findings and exact counts", () => {
    const root = fixture("pkg-ready");
    const rels = ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/cli.js"];
    const report = runCheck(root);
    assert.equal(report.tool, "npmpreflight");
    assert.equal(report.verdict, "READY");
    assert.equal(report.findings.length, 0);
    assert.equal(report.counts["files"], rels.length);
    assert.equal(report.counts["bytes"], totalBytes(root, rels));
    assert.equal(report.counts["findings"], 0);
    assert.equal(report.counts["truncated"], 0);
    assert.match(renderReport(report), /READY/);
  });

  it("pkg-leaky is FIX-FIRST with pattern-only secret evidence", () => {
    const report = runCheck(fixture("pkg-leaky"));
    assert.equal(report.verdict, "FIX-FIRST");
    assert.equal(report.counts["files"], 4);
    const leaks = report.findings.filter((f) => f.rule === "SECRET-LEAK");
    assert.equal(leaks.length, 2);
    assert.deepEqual(
      leaks.map((f) => f.evidence).sort(),
      ["github-pat-classic", "private-key-block"],
    );
    assert.ok(leaks.every((f) => f.file === "src/index.js"));
    assert.deepEqual(
      leaks.map((f) => f.line).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [2, 3],
    );
    const rendered = JSON.stringify(report) + renderReport(report);
    assert.ok(!rendered.includes(FAKE_TOKEN), "the matched secret text must never appear in output");
    assert.ok(!rendered.includes("-----BEGIN"), "the matched key header must never appear in output");
  });

  it("pkg-missing flags the license field and the bin target", () => {
    const report = runCheck(fixture("pkg-missing"));
    assert.equal(report.verdict, "FIX-FIRST");
    assert.equal(report.counts["files"], 3);
    const missingField = report.findings.find((f) => f.rule === "MISSING-FIELD");
    assert.ok(missingField, "expected a MISSING-FIELD finding");
    assert.equal(missingField.evidence, "license");
    const binMissing = report.findings.find((f) => f.rule === "BIN-MISSING");
    assert.ok(binMissing, "expected a BIN-MISSING finding");
    assert.equal(binMissing.evidence, "dist/missing-bin.js");
    assert.ok(!report.findings.some((f) => f.rule === "MAIN-MISSING"), "main exists and is shipped");
    assert.ok(!report.findings.some((f) => f.rule === "SECRET-LEAK"));
  });

  it("pkg-nofiles does not flag the .npmignore-excluded secret file", () => {
    const root = fixture("pkg-nofiles");
    const report = runCheck(root);
    assert.equal(report.verdict, "READY");
    assert.ok(!report.findings.some((f) => f.rule === "SECRET-LEAK"), "leak.txt is excluded by .npmignore and must not be scanned");
    assert.equal(report.counts["files"], 5);
    const shipped = ["package.json", "README.md", "LICENSE", "index.js", ".npmignore"];
    assert.equal(report.counts["bytes"], totalBytes(root, shipped));
    assert.ok(!renderedText(report).includes("leak.txt"), "the excluded file should not be named in findings");
  });
});

function renderedText(report: ReturnType<typeof runCheck>): string {
  return JSON.stringify(report) + renderReport(report);
}

describe("package.json errors", () => {
  it("throws a clear error when package.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "npmpreflight-empty-"));
    tempDirs.push(dir);
    assert.throws(() => runCheck(dir), /package\.json not found/);
  });

  it("throws a clear error when package.json is invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "npmpreflight-invalid-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "package.json"), "{ not json\n", "utf8");
    assert.throws(() => runCheck(dir), /not valid JSON/);
  });
});

describe("field and entry point checks", () => {
  it("flags a main entry that is not shipped", () => {
    const dir = writeTempPackage({ ...COMPLETE_PKG, main: "lib/absent.js" }, BASE_FILES);
    const report = runCheck(dir);
    assert.equal(report.verdict, "FIX-FIRST");
    const finding = report.findings.find((f) => f.rule === "MAIN-MISSING");
    assert.ok(finding);
    assert.equal(finding.evidence, "lib/absent.js");
  });

  it("flags every missing required field", () => {
    const dir = writeTempPackage({ main: "index.js", files: ["index.js"] }, BASE_FILES);
    const report = runCheck(dir);
    const fields = report.findings.filter((f) => f.rule === "MISSING-FIELD").map((f) => f.evidence);
    assert.deepEqual(fields.sort(), ["description", "license", "name", "version"]);
    assert.equal(report.verdict, "FIX-FIRST");
  });

  it("flags a scoped package without public publishConfig, as medium only", () => {
    const dir = writeTempPackage({ ...COMPLETE_PKG, name: "@scope/temp-pkg" }, BASE_FILES);
    const report = runCheck(dir);
    const finding = report.findings.find((f) => f.rule === "SCOPED-NO-PUBLISHCONFIG");
    assert.ok(finding);
    assert.equal(finding.severity, "medium");
    assert.equal(report.verdict, "READY", "medium findings alone do not block the verdict");
  });

  it("accepts a scoped package with publishConfig.access public", () => {
    const dir = writeTempPackage(
      { ...COMPLETE_PKG, name: "@scope/temp-pkg", publishConfig: { access: "public" } },
      BASE_FILES,
    );
    const report = runCheck(dir);
    assert.ok(!report.findings.some((f) => f.rule === "SCOPED-NO-PUBLISHCONFIG"));
    assert.equal(report.verdict, "READY");
  });

  it("reports NO-README as low and NO-ENGINES as info", () => {
    const pkg: Record<string, unknown> = { ...COMPLETE_PKG };
    delete pkg["engines"];
    const dir = writeTempPackage(pkg, { "index.js": BASE_FILES["index.js"] as string, LICENSE: BASE_FILES["LICENSE"] as string });
    const report = runCheck(dir);
    const readme = report.findings.find((f) => f.rule === "NO-README");
    const engines = report.findings.find((f) => f.rule === "NO-ENGINES");
    assert.equal(readme?.severity, "low");
    assert.equal(engines?.severity, "info");
    assert.equal(report.verdict, "READY");
  });
});

describe("secret scanning", () => {
  it("flags a generic api_key assignment by pattern id only", () => {
    const dir = writeTempPackage(
      { ...COMPLETE_PKG, files: ["index.js", "config.js"] },
      { ...BASE_FILES, "config.js": 'export const cfg = { api_key: "ABCDEFGHIJKLMNOP1234567890" };\n' },
    );
    const report = runCheck(dir);
    const leak = report.findings.find((f) => f.rule === "SECRET-LEAK");
    assert.ok(leak);
    assert.equal(leak.evidence, "generic-api-key-assignment");
    assert.equal(leak.file, "config.js");
    assert.ok(!renderedText(report).includes("ABCDEFGHIJKLMNOP1234567890"));
  });

  it("skips binary files via the NUL check", () => {
    const blob = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(FAKE_TOKEN, "utf8")]);
    const dir = writeTempPackage(
      { ...COMPLETE_PKG, files: ["index.js", "blob.bin"] },
      { ...BASE_FILES, "blob.bin": blob },
    );
    const report = runCheck(dir);
    assert.ok(!report.findings.some((f) => f.rule === "SECRET-LEAK"), "a binary file must not be scanned as text");
  });

  it("does not scan a secret that starts past the per-file scan cap", () => {
    const padding = "//" + "a".repeat(600 * 1024) + "\n";
    const dir = writeTempPackage(
      { ...COMPLETE_PKG, files: ["index.js", "big.js"] },
      { ...BASE_FILES, "big.js": padding + `const t = "${FAKE_TOKEN}";\n` },
    );
    const report = runCheck(dir);
    assert.ok(!report.findings.some((f) => f.rule === "SECRET-LEAK"), "content past 512 KiB is outside the scan cap");
  });
});

describe("size checks", () => {
  it("flags a per-file oversize as medium", () => {
    const dir = writeTempPackage(
      { ...COMPLETE_PKG, files: ["index.js", "data.bin"] },
      { ...BASE_FILES, "data.bin": Buffer.alloc(1024 * 1024 + 1, 65) },
    );
    const report = runCheck(dir);
    const over = report.findings.find((f) => f.rule === "OVERSIZE");
    assert.ok(over);
    assert.equal(over.severity, "medium");
    assert.equal(over.file, "data.bin");
    assert.equal(report.counts["bytes"], totalBytes(dir, ["package.json", "README.md", "LICENSE", "index.js", "data.bin"]));
  });
});

describe("caps and determinism", () => {
  it("caps the shipped set and records the cap in counts", { timeout: 120000 }, () => {
    const pkg: Record<string, unknown> = { ...COMPLETE_PKG };
    delete pkg["files"];
    const extras: Record<string, string> = { ...BASE_FILES };
    for (let i = 0; i < MAX_FILES + 5; i++) {
      extras[`data/f${String(i).padStart(5, "0")}.txt`] = "x\n";
    }
    const dir = writeTempPackage(pkg, extras);
    const report = runCheck(dir);
    assert.equal(report.counts["files"], MAX_FILES);
    assert.equal(report.counts["truncated"], 1);
    assert.ok((report.counts["filesSeen"] ?? 0) > MAX_FILES);
  });

  it("produces identical output on repeated runs", () => {
    const a = runCheck(fixture("pkg-leaky"));
    const b = runCheck(fixture("pkg-leaky"));
    assert.deepEqual(a, b);
    assert.equal(renderReport(a), renderReport(b));
  });
});
