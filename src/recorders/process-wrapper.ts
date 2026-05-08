/**
 * Process Wrapper
 * Wraps agent commands and captures output without native dependencies
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

export class ProcessWrapper extends EventEmitter {
  private child?: ChildProcess;
  private outputBuffer: string[] = [];
  private startTime?: number;
  private outputPath: string;
  private stdoutData = "";
  private stderrData = "";

  constructor(private workspacePath: string) {
    super();
    this.outputPath = path.join(workspacePath, "output.log");
  }

  async spawn(command: string, args: string[] = [], options: ProcessWrapperOptions = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      this.startTime = Date.now();

      const spawnOptions: SpawnOptions = {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
        shell: options.shell ?? true,
        stdio: ["inherit", "pipe", "pipe"],
      };

      // Handle command that might be a shell string
      let finalCommand = command;
      let finalArgs = args;

      if (args.length === 0 && command.includes(" ")) {
        // Single command with arguments - use shell
        spawnOptions.shell = true;
      }

      this.emit("spawn", { command: finalCommand, args: finalArgs, timestamp: this.startTime });

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
          stderr: this.stderrData
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
    const output = `=== STDOUT ===\n${this.stdoutData}\n\n=== STDERR ===\n${this.stderrData}`;
    await fs.writeFile(this.outputPath, output);
  }

  getOutput(): { stdout: string; stderr: string } {
    return {
      stdout: this.stdoutData,
      stderr: this.stderrData,
    };
  }
}
