/**
 * Process Wrapper
 * Wraps agent commands and captures comprehensive output
 */

import { spawn, SpawnOptions, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";

interface ProcessWrapperOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}

interface ProcessEvent {
  command: string;
  args: string[];
  cwd: string;
  timestamp: number;
}

export class ProcessWrapper extends EventEmitter {
  private child?: ChildProcess;
  private startTime?: number;
  private outputPath: string;
  private stdoutData = "";
  private stderrData = "";
  private commands: ProcessEvent[] = [];

  constructor(private workspacePath: string) {
    super();
    this.outputPath = path.join(workspacePath, "output.log");
  }

  async spawn(command: string, args: string[] = [], options: ProcessWrapperOptions = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      this.startTime = Date.now();
      const cwd = options.cwd || process.cwd();

      // Record the command
      const event: ProcessEvent = {
        command,
        args,
        cwd,
        timestamp: this.startTime,
      };
      this.commands.push(event);
      this.emit("spawn", event);

      const spawnOptions: SpawnOptions = {
        cwd,
        env: { ...process.env, ...options.env, FORCE_COLOR: "1" },
        shell: options.shell ?? true,
        stdio: ["inherit", "pipe", "pipe"],
      };

      // Handle command with spaces
      let finalCommand = command;
      let finalArgs = args;

      if (args.length === 0 && command.includes(" ")) {
        spawnOptions.shell = true;
      }

      this.child = spawn(finalCommand, finalArgs, spawnOptions);

      // Capture stdout
      this.child.stdout?.on("data", (data: Buffer) => {
        const str = data.toString();
        this.stdoutData += str;
        this.emit("stdout", str);
        process.stdout.write(str);
      });

      // Capture stderr
      this.child.stderr?.on("data", (data: Buffer) => {
        const str = data.toString();
        this.stderrData += str;
        this.emit("stderr", str);
        process.stderr.write(str);
      });

      // Handle exit
      this.child.on("exit", async (code: number | null, signal: NodeJS.Signals | null) => {
        const duration = Date.now() - this.startTime!;
        await this.saveOutput();
        
        this.emit("exit", { 
          code: code ?? (signal ? 1 : 0), 
          signal,
          duration,
          stdout: this.stdoutData,
          stderr: this.stderrData,
          commands: this.commands,
        });
        
        resolve(code ?? (signal ? 1 : 0));
      });

      this.child.on("error", (err: Error) => {
        this.emit("error", err);
        reject(err);
      });
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child?.kill(signal);
  }

  private async saveOutput(): Promise<void> {
    const output = [
      "=== STDOUT ===",
      this.stdoutData,
      "",
      "=== STDERR ===",
      this.stderrData,
      "",
      "=== SUMMARY ===",
      `Commands run: ${this.commands.length}`,
      `Duration: ${this.startTime ? Date.now() - this.startTime : 0}ms`,
    ].join("\n");
    
    try {
      await fs.writeFile(this.outputPath, output);
    } catch {
      // Ignore write errors
    }
  }

  getOutput(): { stdout: string; stderr: string; commands: ProcessEvent[] } {
    return {
      stdout: this.stdoutData,
      stderr: this.stderrData,
      commands: this.commands,
    };
  }

  isRunning(): boolean {
    return this.child ? !this.child.killed : false;
  }
}
