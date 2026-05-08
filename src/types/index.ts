/**
 * TraceHound Types
 * Core type definitions for the TraceHound system
 */

// ============================================================================
// Run Configuration
// ============================================================================

export interface TraceHoundOptions {
  name?: string;
  agent?: string;
  mode?: "record" | "warn" | "enforce";
  netMode?: "observe" | "proxy" | "off";
}

export interface RunResult {
  runId: string;
  durationMs: number;
  exitCode: number;
  warnings: string[];
}

// ============================================================================
// Manifest
// ============================================================================

export interface RunManifest {
  schema: string;
  run: {
    id: string;
    name?: string;
    timestamp: string;
    durationMs: number;
    exitCode: number;
  };
  agent: {
    name: string;
    command: string[];
  };
  repo: {
    root: string;
    git: GitInfo;
  };
  summary: RunSummary;
  warnings: string[];
  agentMetadata?: Record<string, unknown>;
}

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  commit?: string;
  dirty?: boolean;
  remoteUrl?: string;
}

export interface RunSummary {
  filesModified: number;
  commandsRun: number;
  networkConnections: number;
  secretsAccessed: number;
}

// ============================================================================
// Events
// ============================================================================

export type EventType =
  | "session.start"
  | "session.end"
  | "file.read"
  | "file.write"
  | "file.delete"
  | "file.chmod"
  | "process.exec"
  | "process.spawn"
  | "process.exit"
  | "network.connect"
  | "network.dns"
  | "network.http"
  | "package.install"
  | "package.remove"
  | "secret.access"
  | "terminal.output"
  | "terminal.input"
  | "git.commit"
  | "git.branch"
  | "policy.violation";

export interface AgentEvent {
  ts: string;
  type: EventType;
  runId: string;
  [key: string]: unknown;
}

export interface FileEvent extends AgentEvent {
  type: "file.read" | "file.write" | "file.delete";
  path: string;
  size?: number;
  hash?: string;
}

export interface ProcessEvent extends AgentEvent {
  type: "process.exec";
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  exitCode?: number;
}

export interface NetworkEvent extends AgentEvent {
  type: "network.connect" | "network.dns" | "network.http";
  protocol: string;
  host?: string;
  ip?: string;
  port?: number;
  method?: string;
  path?: string;
}

export interface SecretEvent extends AgentEvent {
  type: "secret.access";
  path: string;
  category: "env" | "ssh" | "aws" | "gcp" | "azure" | "token" | "key" | "other";
  redacted: boolean;
}

export interface TerminalEvent extends AgentEvent {
  type: "terminal.output" | "terminal.input";
  data: string;
}

// ============================================================================
// Policy
// ============================================================================

export interface Policy {
  mode: "off" | "record" | "warn" | "enforce";
  allowedPaths?: string[];
  blockedPaths?: string[];
  network?: NetworkPolicy;
  packages?: PackagePolicy;
  commands?: CommandPolicy;
  secrets?: SecretPolicy;
}

export interface NetworkPolicy {
  default: "allow" | "warn" | "block";
  allow?: string[];
  block?: string[];
  unknownDomains?: "allow" | "warn" | "block";
}

export interface PackagePolicy {
  requireApproval?: boolean;
  blockLatest?: boolean;
  allow?: string[];
  block?: string[];
}

export interface CommandPolicy {
  requireApproval?: string[];
  block?: string[];
}

export interface SecretPolicy {
  warn?: boolean;
  block?: boolean;
}

export interface PolicyDecision {
  action: "allow" | "warn" | "block" | "require_approval";
  reason?: string;
  rule?: string;
}

// ============================================================================
// Store
// ============================================================================

export interface RunEntry {
  id: string;
  name?: string;
  timestamp: string;
  agent?: string;
  summary: RunSummary;
}
