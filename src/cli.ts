#!/usr/bin/env node
/**
 * npmpreflight CLI.
 *
 *   npmpreflight check [target] [--json]
 *   npmpreflight mcp
 *   npmpreflight --version
 *
 * Exit codes: 0 when the verdict is READY, 1 for any other verdict,
 * 2 usage error, 141 when the reader closed the output pipe early
 * (the shell-visible equivalent of death by SIGPIPE). The emit contract
 * follows FACTORY-NOTES.md: one flush-aware write, exitCode never
 * process.exit on report paths.
 */
import { runCheck, renderReport, CLEAN_VERDICT, VERSION } from "./core.js";

function exitBrokenPipe(): never {
  process.exit(141);
}

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") exitBrokenPipe();
  throw err;
});

async function emit(text: string, code: number): Promise<void> {
  process.exitCode = code;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${text}\n`, (err) => {
      if (!err) {
        resolve();
        return;
      }
      if ((err as NodeJS.ErrnoException).code === "EPIPE") exitBrokenPipe();
      reject(err);
    });
  });
}

function usage(): never {
  console.error(`Usage:
  npmpreflight check [target] [--json]
  npmpreflight mcp
  npmpreflight --version`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (cmd !== "check") usage();
  const target = rest.find((a) => !a.startsWith("--")) ?? ".";
  try {
    const report = runCheck(target);
    const text = rest.includes("--json") ? JSON.stringify(report, null, 2) : renderReport(report);
    await emit(text, report.verdict === CLEAN_VERDICT ? 0 : 1);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}

void main();
