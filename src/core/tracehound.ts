/**
 * TraceHound Core
 * Main orchestrator for tracking agent sessions
 */

import { EventEmitter } from "events";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { nanoid } from "nanoid";
import { ProcessWrapper } from "../recorders/process-wrapper.js";
import { FilesystemMonitor } from "../recorders/filesystem-monitor.js";
import { SecretDetector } from "../recorders/secret-detector.js";
import { PolicyEngine } from "../policies/policy-engine.js";
import { TraceWriter } from "./trace-writer.js";
import { RunManifest, TraceHoundOptions, RunResult, AgentEvent } from "../types/index.js";

export interface TraceHoundConfig extends TraceHoundOptions {
  workspacePath: string;
  runId: string;
  startTime: Date;
}

export class TraceHound extends EventEmitter {
  private config: TraceHoundConfig;
  private processWrapper: ProcessWrapper;
  private filesystemMonitor: FilesystemMonitor;
  private secretDetector: SecretDetector;
  private policyEngine: PolicyEngine;
  private traceWriter: TraceWriter;
  private events: AgentEvent[] = [];
  private warnings: string[] = [];
  private commands: Array<{ ts: string; command: string }> = [];
  private filesModified = 0;
  private secretsAccessed = 0;

  constructor(options: TraceHoundOptions) {
    super();
    
    const runId = this.generateRunId();
    const workspacePath = path.join(process.cwd(), ".tracehound", "runs", runId);
    
    this.config = {
      ...options,
      runId,
      workspacePath,
      startTime: new Date(),
    };

    // Initialize components
    this.traceWriter = new TraceWriter(workspacePath);
    this.processWrapper = new ProcessWrapper(workspacePath);
    this.filesystemMonitor = new FilesystemMonitor();
    this.secretDetector = new SecretDetector();
    this.policyEngine = new PolicyEngine();
  }

  async run(agentCommand: string): Promise<RunResult> {
    await this.initialize();
    
    try {
      // Start recording
      await this.startRecording();
      
      // Run the agent
      const exitCode = await this.executeAgent(agentCommand);
      
      // Stop recording
      await this.stopRecording();
      
      // Generate manifest
      const result = await this.finalize(exitCode);
      
      return result;
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    // Create workspace
    await fs.mkdir(this.config.workspacePath, { recursive: true });
    
    // Initialize trace writer
    await this.traceWriter.initialize();
    
    // Capture initial git state
    await this.captureGitBefore();
    
    // Load policy
    await this.policyEngine.load();

    this.emit("initialized", { runId: this.config.runId });
  }

  private async startRecording(): Promise<void> {
    // Start filesystem monitoring
    await this.filesystemMonitor.start(
      process.cwd(),
      this.config.runId,
      (event) => this.handleFilesystemEvent(event)
    );
    
    // Setup process wrapper event handlers
    this.processWrapper.on("spawn", (data) => {
      this.commands.push({
        ts: new Date().toISOString(),
        command: `${data.command} ${data.args?.join(" ") || ""}`
      });
    });

    this.emit("recording-started", { runId: this.config.runId });
  }

  private async executeAgent(agentCommand: string): Promise<number> {
    // Parse command
    const parts = agentCommand.trim().split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    return await this.processWrapper.spawn(command, args, {
      cwd: process.cwd(),
      shell: true,
    });
  }

  private async stopRecording(): Promise<void> {
    // Stop filesystem monitoring
    await this.filesystemMonitor.stop();
    
    // Close trace writer
    await this.traceWriter.close();
    
    // Capture final git state
    await this.captureGitAfter();
    
    this.emit("recording-stopped", { runId: this.config.runId });
  }

  private async finalize(exitCode: number): Promise<RunResult> {
    const endTime = new Date();
    const durationMs = endTime.getTime() - this.config.startTime.getTime();
    
    // Get git info
    const gitInfo = await this.getGitInfo();
    
    // Generate manifest
    const manifest: RunManifest = {
      schema: "tracehound.manifest.v1",
      run: {
        id: this.config.runId,
        name: this.config.name,
        timestamp: this.config.startTime.toISOString(),
        durationMs,
        exitCode,
      },
      agent: {
        name: this.config.agent || "unknown",
        command: (this.commands[0]?.command || "").split(" "),
      },
      repo: {
        root: process.cwd(),
        git: gitInfo,
      },
      summary: {
        filesModified: this.filesModified,
        commandsRun: this.commands.length,
        networkConnections: 0, // Not implemented yet
        secretsAccessed: this.secretsAccessed,
      },
      warnings: this.warnings,
    };
    
    // Write manifest
    await this.traceWriter.writeManifest(manifest);

    // Generate report
    const { ReportGenerator } = await import("../reports/report-generator.js");
    const generator = new ReportGenerator(manifest);
    await generator.generateMarkdownReport();
    await generator.generateHtml();
    
    return {
      runId: this.config.runId,
      durationMs,
      exitCode,
      warnings: this.warnings,
    };
  }

  private handleFilesystemEvent(event: AgentEvent): void {
    // Track files modified
    if (event.type === "file.write" || event.type === "file.delete") {
      this.filesModified++;
    }
    
    // Check for secret access
    if (event.path && this.secretDetector.isSecretPath(event.path)) {
      this.secretsAccessed++;
      this.warnings.push(`Secret file touched: ${event.path}`);
      
      const secretEvent: AgentEvent = {
        ts: event.ts,
        type: "secret.access",
        runId: this.config.runId,
        path: event.path,
        category: this.secretDetector.getSecretCategory(event.path) || "other",
        redacted: true,
      };
      
      this.traceWriter.writeEvent(secretEvent);
    }
    
    // Check policy
    if (event.type === "file.write" || event.type === "file.delete") {
      const decision = this.policyEngine.evaluateFilesystem(event as any);
      if (decision.action !== "allow") {
        this.warnings.push(`Policy ${decision.action}: ${decision.reason}`);
      }
    }
    
    this.events.push(event);
    this.traceWriter.writeEvent(event);
  }

  private async captureGitBefore(): Promise<void> {
    try {
      const { exec } = await import("child_process");
      const patchPath = path.join(this.config.workspacePath, "git-before.patch");
      
      exec("git diff", { cwd: process.cwd() }, async (error, stdout) => {
        await fs.writeFile(patchPath, stdout);
      });
    } catch {
      // Not a git repo
    }
  }

  private async captureGitAfter(): Promise<void> {
    try {
      const { exec } = await import("child_process");
      const patchPath = path.join(this.config.workspacePath, "git-after.patch");
      
      exec("git diff", { cwd: process.cwd() }, async (error, stdout) => {
        await fs.writeFile(patchPath, stdout);
      });
    } catch {
      // Not a git repo
    }
  }

  private async getGitInfo(): Promise<any> {
    try {
      const { execSync } = await import("child_process");
      
      const branch = execSync("git branch --show-current", { 
        cwd: process.cwd(),
        encoding: "utf-8",
        timeout: 1000 
      }).trim();
      
      const commit = execSync("git rev-parse HEAD", {
        cwd: process.cwd(),
        encoding: "utf-8",
        timeout: 1000
      }).trim();
      
      const status = execSync("git status --porcelain", {
        cwd: process.cwd(),
        encoding: "utf-8",
        timeout: 1000
      }).trim();
      
      return {
        isRepo: true,
        branch,
        commit: commit.slice(0, 8),
        dirty: status.length > 0,
      };
    } catch {
      return { isRepo: false };
    }
  }

  private async cleanup(): Promise<void> {
    try {
      await this.filesystemMonitor.stop();
      await this.traceWriter.close();
    } catch {
      // Ignore cleanup errors
    }
  }

  private generateRunId(): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const shortId = nanoid(6);
    return `${timestamp}_${shortId}`;
  }
}
