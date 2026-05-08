/**
 * Filesystem Monitor
 * Watches file system events using chokidar
 */

import chokidar from "chokidar";
import * as fs from "fs/promises";
import * as path from "path";
import { FileEvent, AgentEvent } from "../types/index.js";

export class FilesystemMonitor {
  private watcher?: chokidar.FSWatcher;
  private eventHandler?: (event: AgentEvent) => void;
  private runId: string = "";
  private processedFiles = new Set<string>();
  private fileHashes = new Map<string, string>();

  async start(
    rootPath: string,
    runId: string,
    onEvent: (event: AgentEvent) => void
  ): Promise<void> {
    this.eventHandler = onEvent;
    this.runId = runId;

    // Get initial file hashes for comparison
    await this.captureInitialState(rootPath);

    // Watch with chokidar - ignore node_modules and .git
    this.watcher = chokidar.watch(rootPath, {
      ignored: [
        /(^|[\/\\])\../,  // dotfiles
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/.tracehound/**",
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    // Handle add events
    this.watcher.on("add", async (filePath) => {
      if (this.processedFiles.has(filePath)) return;
      this.processedFiles.add(filePath);

      const relativePath = path.relative(rootPath, filePath);
      const size = await this.getFileSize(filePath);
      const hash = await this.getFileHash(filePath);
      
      const event: FileEvent = {
        ts: new Date().toISOString(),
        type: "file.write",
        runId,
        path: relativePath,
        size,
        hash,
      };

      this.eventHandler?.(event);
    });

    // Handle change events
    this.watcher.on("change", async (filePath) => {
      const relativePath = path.relative(rootPath, filePath);
      const size = await this.getFileSize(filePath);
      const hash = await this.getFileHash(filePath);
      const beforeHash = this.fileHashes.get(filePath);

      const event: FileEvent = {
        ts: new Date().toISOString(),
        type: "file.write",
        runId,
        path: relativePath,
        size,
        hash_after: hash,
        hash_before: beforeHash,
      };

      this.fileHashes.set(filePath, hash);
      this.eventHandler?.(event);
    });

    // Handle unlink events
    this.watcher.on("unlink", (filePath) => {
      const relativePath = path.relative(rootPath, filePath);
      
      const event: FileEvent = {
        ts: new Date().toISOString(),
        type: "file.delete",
        runId,
        path: relativePath,
      };

      this.processedFiles.delete(filePath);
      this.fileHashes.delete(filePath);
      this.eventHandler?.(event);
    });

    // Wait for watcher to be ready
    await new Promise((resolve) => {
      this.watcher?.on("ready", resolve);
    });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.processedFiles.clear();
    this.fileHashes.clear();
  }

  private async captureInitialState(rootPath: string): Promise<void> {
    // Try to capture git-tracked files initially
    try {
      const gitLsFiles = await this.execGit("ls-files", rootPath);
      const files = gitLsFiles.split("\n").filter(f => f.trim());
      
      for (const file of files.slice(0, 100)) { // Limit to first 100 files
        const fullPath = path.join(rootPath, file);
        try {
          const hash = await this.getFileHash(fullPath);
          this.fileHashes.set(fullPath, hash);
        } catch {
          // File might not exist
        }
      }
    } catch {
      // Not a git repo or git not available
    }
  }

  private async getFileSize(filePath: string): Promise<number | undefined> {
    try {
      const stats = await fs.stat(filePath);
      return stats.size;
    } catch {
      return undefined;
    }
  }

  private async getFileHash(filePath: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(filePath);
      // Simple hash - in production use crypto
      return `md5:${Buffer.from(content).toString("base64").slice(0, 16)}`;
    } catch {
      return undefined;
    }
  }

  private async execGit(command: string, cwd: string): Promise<string> {
    const { exec } = await import("child_process");
    return new Promise((resolve, reject) => {
      exec(`git ${command}`, { cwd }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }
}
