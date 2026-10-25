/**
 * npmpreflight MCP server. Tool: preflight_package.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheck, VERSION } from "./core.js";

const server = new McpServer({ name: "npmpreflight", version: VERSION });

server.tool(
  "preflight_package",
  "Audit a package directory before publishing: resolves the shipped file set from the files field and ignore rules, scans shipped files for secret patterns (private keys, token shapes), totals the size, and checks package.json for required fields, a bin target that exists, license, and publishConfig on scoped names. Verdict READY or FIX-FIRST with evidence.",
  {
    path: z.string().describe("Target path to check"),
  },
  async ({ path }) => {
    const report = runCheck(path);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
