export type Severity = "info" | "low" | "medium" | "high";

export interface Finding {
  rule: string;
  severity: Severity;
  file?: string;
  line?: number;
  message: string;
  evidence?: string;
}

export interface Report {
  tool: string;
  version: string;
  target: string;
  verdict: string;
  counts: Record<string, number>;
  findings: Finding[];
  summary: string;
}
