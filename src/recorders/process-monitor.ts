/**
 * Process Monitor
 * Tracks spawned processes
 */

import { AgentEvent, ProcessEvent } from "../types/index.js";

export class ProcessMonitor {
  private eventHandler?: (event: AgentEvent) => void;
  private processes = new Map<number, ProcessInfo>();

  start(onEvent: (event: AgentEvent) => void): void {
    this.eventHandler = onEvent;
    
    // In a real implementation, this would hook into
    // process creation via platform-specific APIs (eBPF, ETW, etc.)
    // For MVP, we rely on shell tracing and manual instrumentation
  }

  stop(): void {
    // Cleanup
  }

  // This would be called by the PTY recorder when spawning processes
  trackProcess(pid: number, ppid: number, cwd: string, argv: string[]): void {
    this.processes.set(pid, { pid, ppid, cwd, argv });
    
    const event: ProcessEvent = {
      ts: new Date().toISOString(),
      type: "process.exec",
      runId: "", // Set by TraceHound
      pid,
      ppid,
      cwd,
      argv,
    };
    
    this.eventHandler?.(event);
  }

  recordExit(pid: number, exitCode: number): void {
    const event: AgentEvent = {
      ts: new Date().toISOString(),
      type: "process.exit",
      runId: "",
      pid,
      exitCode,
    };
    
    this.eventHandler?.(event);
    this.processes.delete(pid);
  }
}

interface ProcessInfo {
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
}
