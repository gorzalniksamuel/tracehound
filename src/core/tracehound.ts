/**
 * TraceHound Core
 * Main orchestrator for tracking agent sessions
 */

import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import { nanoid } from "nanoid";
import { ProcessWrapper } from "../recorders/process-wrapper.js";
import { FilesystemMonitor } from "../recorders/filesystem-monitor.js";
import { SecretDetector } from "../recorders/secret-detector.js";
import { PassiveNetworkMonitor } from "../recorders/network-proxy.js";
import { PolicyEngine } from "../policies/policy-engine.js";
import { TraceWriter } from "./trace-writer.js";
import { OpenClawAdapter } from "../adapters/openclaw.js";
import { RunManifest, TraceHoundOptions, RunResult, AgentEvent, FileEvent } from "../types/index.js";

export interface TraceHoundConfig extends TraceHoundOptions {
  workspacePath: string;
  runId: string;
  startTime: Date;
}

export class TraceHound extends EventEmitter {
  private config: TraceHoundConfig;
  private processWrapper: ProcessWrapper;
  private filesystemMonitor: FilesystemMonitor;
  private networkMonitor: PassiveNetworkMonitor;
  private secretDetector: SecretDetector;
  private policyEngine: PolicyEngine;
  private traceWriter: TraceWriter;
  private events: AgentEvent[] = [];
  private openclawAdapter?: OpenClawAdapter;
  private warnings: string[] = [];
  private commands: Array<{ ts: string; command: string }> = [];
  private filesModified = 0;
  private secretsAccessed = 0;
  private networkConnections = 0;

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

    this.traceWriter = new TraceWriter(workspacePath);
    this.processWrapper = new ProcessWrapper(workspacePath);
    this.filesystemMonitor = new FilesystemMonitor();
    this.networkMonitor = new PassiveNetworkMonitor();
    this.secretDetector = new SecretDetector();
    this.policyEngine = new PolicyEngine();
    
    // Initialize OpenClaw adapter if needed
    if (options.agent === "openclaw") {
      this.openclawAdapter = new OpenClawAdapter();
    }
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
      (event) => this.handleFilesystemEvent(event as FileEvent)
    );
    
    // Start network monitoring
    await this.networkMonitor.start(
      this.config.runId,
      (event) => {
        this.networkConnections++;
        this.events.push(event);
        this.traceWriter.writeEvent(event);
      }
    );
    
    // Setup process wrapper event handlers
    this.processWrapper.on("spawn", (data) => {
      this.commands.push({
        ts: new Date().toISOString(),
        command: `${data.command} ${data.args?.join(" ") || ""}`
      });
    });

    // Parse OpenClaw output if applicable
    if (this.openclawAdapter) {
      this.processWrapper.on("stdout", (data: string) => {
        for (const line of data.split("\n")) {
          const event = this.openclawAdapter!.parseOutput(line);
          if (event) {
            this.events.push(event);
            this.traceWriter.writeEvent(event);
            
            // Log delegation events
            if (event.action === "delegate") {
              this.warnings.push(`OpenClaw delegated to ${event.childAgent}`);
            }
          }
        }
      });
    }

    this.emit("recording-started", { runId: this.config.runId });
  }

  private async executeAgent(agentCommand: string): Promise<number> {
    const parts = agentCommand.trim().split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    return await this.processWrapper.spawn(command, args, {
      cwd: process.cwd(),
      shell: true,
    });
  }

  private async stopRecording(): Promise<void> {
    // Stop all monitors
    await this.filesystemMonitor.stop();
    await this.networkMonitor.stop();
    
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
    
    // Calculate risk score
    const riskScore = this.calculateRiskScore();
    
    // Generate summary
    const summary = {
      filesModified: this.filesModified,
      commandsRun: this.commands.length,
      networkConnections: this.networkConnections,
      secretsAccessed: this.secretsAccessed,
      riskScore: riskScore.score,
      riskLevel: riskScore.level,
    };

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
      summary,
      warnings: this.warnings,
    };
    
    // OpenClaw-specific enrichment
    if (this.openclawAdapter) {
      manifest.agentMetadata = {
        openclaw: this.openclawAdapter.getDelegationTree(),
        tree: this.openclawAdapter.formatTree(),
      };
      
      // Add formatted tree to warnings for display
      const tree = this.openclawAdapter.formatTree();
      this.warnings.unshift(tree);
    }
    
    // Write manifest
    await this.traceWriter.writeManifest(manifest);

    // Generate report
    const { ReportGenerator } = await import("../reports/report-generator.js");
    const generator = new ReportGenerator(manifest);
    await generator.generateMarkdownReport();
    await generator.generateHtml();
    
    // Print summary
    console.log("\n" + "=".repeat(50));
    console.log("📊 TraceHound Summary");
    console.log("=".repeat(50));
    console.log(`Files Modified:     ${summary.filesModified}`);
    console.log(`Commands Run:       ${summary.commandsRun}`);
    console.log(`Network Connections: ${summary.networkConnections}`);
    console.log(`Secrets Accessed:   ${summary.secretsAccessed}`);
    console.log(`Risk Score:         ${summary.riskScore} (${summary.riskLevel})`);
    console.log("=".repeat(50));
    
    if (this.warnings.length > 0) {
      console.log("\n⚠️  Warnings:");
      this.warnings.forEach(w => console.log(`  - ${w}`));
    }
    
    return {
      runId: this.config.runId,
      durationMs,
      exitCode,
      warnings: this.warnings,
    };
  }

  private handleFilesystemEvent(event: FileEvent): void {
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
    if (event.type === "file.write") {
      const decision = this.policyEngine.evaluateFilesystem(event);
      if (decision.action !== "allow") {
        this.warnings.push(`Policy ${decision.action}: ${decision.reason}`);
      }
    }
    
    this.events.push(event);
    this.traceWriter.writeEvent(event);
  }

  private calculateRiskScore(): { score: number; level: string } {
    let score = 0;
    
    // Risk factors
    score += this.filesModified * 1;
    score += this.commands.length * 0.5;
    score += this.networkConnections * 2;
    score += this.secretsAccessed * 10;
    score += this.warnings.length * 3;
    
    // Determine level
    let level = "Low 🟢";
    if (score >= 10) {
      level = "Medium 🟡";
    }
    if (score >= 25) {
      level = "High 🔴";
    }
    
    return { score, level };
  }

  private async captureGitBefore(): Promise<void> {
    try {
      const { execAsync } = await import("../utils/exec.js");
      const patchPath = path.join(this.config.workspacePath, "git-before.patch");
      
      const { stdout } = await execAsync("git diff 2>/dev/null || echo ''", { cwd: process.cwd() });
      await fs.writeFile(patchPath, stdout);
    } catch {
      // Not a git repo
    }
  }

  private async captureGitAfter(): Promise<void> {
    try {
      const { execAsync } = await import("../utils/exec.js");
      const patchPath = path.join(this.config.workspacePath, "git-after.patch");
      
      const { stdout } = await execAsync("git diff 2>/dev/null || echo ''", { cwd: process.cwd() });
      await fs.writeFile(patchPath, stdout);
    } catch {
      // Not a git repo
    }
  }

  private async getGitInfo(): Promise<any> {
    try {
      const { execAsync } = await import("../utils/exec.js");
      
      const [{ stdout: branch }, { stdout: commit }, { stdout: status }] = await Promise.all([
        execAsync("git branch --show-current 2>/dev/null || echo 'unknown'", { cwd: process.cwd() }),
        execAsync("git rev-parse HEAD 2>/dev/null || echo 'unknown'", { cwd: process.cwd() }),
        execAsync("git status --porcelain 2>/dev/null || echo ''", { cwd: process.cwd() }),
      ]);
      
      return {
        isRepo: true,
        branch: branch.trim(),
        // Truncate commit to 8 characters
        commit: commit.trim().slice(0, 8),
        dirty: status.trim().length > 0,
      };
    } catch {
      return { isRepo: false };
    }
  }

  private async cleanup(): Promise<void> {
    try {
      await this.filesystemMonitor.stop();
      await this.networkMonitor.stop();
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
