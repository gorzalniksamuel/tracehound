/**
 * Filesystem Monitor
 * Smart file tracking using fd (find) for efficiency
 */

import * as chokidar from "chokidar";
import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { FileEvent, AgentEvent } from "../types/index.js";

const execAsync = promisify(exec);

export class FilesystemMonitor {
  private watcher?: chokidar.FSWatcher;
  private eventHandler?: (event: AgentEvent) => void;
  private runId: string = "";
  private fileHashes = new Map<string, string>();
  private watchedFiles = new Set<string>();
  private rootPath: string = "";

  async start(
    rootPath: string,
    runId: string,
    onEvent: (event: AgentEvent) => void
  ): Promise<void> {
    this.eventHandler = onEvent;
    this.runId = runId;
    this.rootPath = rootPath;

    // Capture initial state of git-tracked and recently modified files
    await this.captureInitialState(rootPath);

    // Watch only specific files/dirs, not everything
    const watchPaths = await this.getWatchPaths(rootPath);
    
    if (watchPaths.length === 0) {
      console.log("⚠️  No files to watch - running without file monitoring");
      return;
    }

    console.log(`📁 Watching ${watchPaths.length} paths...`);

    this.watcher = chokidar.watch(watchPaths, {
      ignored: [
        /(^|[\/\\])\../,  // dotfiles
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/.tracehound/**",
        "**/*.log",
        "**/*.tmp",
        "**/*.temp",
        "**/.DS_Store",
        "**/Thumbs.db",
      ],
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
      ignorePermissionErrors: true,
    });

    // Handle file events
    this.watcher.on("add", (filePath) => this.handleFileChange(filePath, "add"));
    this.watcher.on("change", (filePath) => this.handleFileChange(filePath, "change"));
    this.watcher.on("unlink", (filePath) => this.handleFileDelete(filePath));

    // Silent error handling
    this.watcher.on("error", () => {
      // Silently ignore - EMFILE etc handled by ignorePermissionErrors
    });

    // Wait for ready
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 3000);
      this.watcher?.on("ready", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watchedFiles.clear();
    this.fileHashes.clear();
  }

  /**
   * Get list of paths to watch using fd (if available) or git
   */
  private async getWatchPaths(rootPath: string): Promise<string[]> {
    const paths: string[] = [];
    const maxFiles = 500; // Limit to prevent EMFILE
    
    try {
      // Try fd command first (fastest)
      const { stdout: fdOutput } = await execAsync(
        `fd --type f --changed-within 1h --max-results ${maxFiles} . "${rootPath}" 2>/dev/null || echo ""`,
        { timeout: 5000 }
      );
      
      const fdFiles = fdOutput.split("\n").filter(f => f.trim() && !this.shouldIgnore(f));
      paths.push(...fdFiles.slice(0, maxFiles));
    } catch {
      // fd not available, try git
      try {
        const { stdout: gitOutput } = await execAsync(
          `git ls-files --others --exclude-standard --modified 2>/dev/null | head -${maxFiles}`,
          { cwd: rootPath, timeout: 5000 }
        );
        
        const gitFiles = gitOutput.split("\n")
          .filter(f => f.trim())
          .map(f => path.join(rootPath, f));
        paths.push(...gitFiles);
      } catch {
        // Not a git repo - fall back to watching nothing
      }
    }

    // If still empty, try to find recently modified files manually
    if (paths.length === 0) {
      try {
        const entries = await fs.readdir(rootPath, { withFileTypes: true });
        for (const entry of entries.slice(0, 50)) {
          if (entry.isFile() && !this.shouldIgnore(entry.name)) {
            paths.push(path.join(rootPath, entry.name));
          } else if (entry.isDirectory() && !this.shouldIgnore(entry.name)) {
            // Add top-level dirs only
            paths.push(path.join(rootPath, entry.name));
          }
        }
      } catch {
        // Can't read dir
      }
    }

    return [...new Set(paths)].slice(0, maxFiles);
  }

  private shouldIgnore(filePath: string): boolean {
    const ignorePatterns = [
      /node_modules/,
      /\.git/,
      /\.tracehound/,
      /dist/,
      /build/,
      /Library/,
      /Applications/,
      /\.log$/,
      /\.tmp$/,
      /\.DS_Store$/,
    ];
    return ignorePatterns.some(p => p.test(filePath));
  }

  private async captureInitialState(rootPath: string): Promise<void> {
    try {
      // Get git-tracked files with hashes
      const { stdout } = await execAsync(
        "git ls-files | head -200",
        { cwd: rootPath, timeout: 3000 }
      );
      
      const files = stdout.split("\n").filter(f => f.trim());
      
      for (const file of files) {
        const fullPath = path.join(rootPath, file);
        try {
          const hash = await this.getFileHash(fullPath);
          if (hash) {
            this.fileHashes.set(fullPath, hash);
          }
        } catch {
          // Skip files we can't read
        }
      }
    } catch {
      // Not a git repo
    }
  }

  private async handleFileChange(filePath: string, eventType: "add" | "change"): Promise<void> {
    try {
      const relativePath = path.relative(this.rootPath, filePath);
      const size = await this.getFileSize(filePath);
      const hash = await this.getFileHash(filePath);
      const beforeHash = this.fileHashes.get(filePath);

      const event: FileEvent = {
        ts: new Date().toISOString(),
        type: eventType === "add" ? "file.write" : "file.write",
        runId: this.runId,
        path: relativePath,
        size,
        hash_after: hash,
        hash_before: beforeHash,
      };

      if (hash) {
        this.fileHashes.set(filePath, hash);
      }
      this.watchedFiles.add(filePath);
      this.eventHandler?.(event);
    } catch {
      // Silently skip files we can't process
    }
  }

  private handleFileDelete(filePath: string): void {
    const relativePath = path.relative(this.rootPath, filePath);
    
    const event: FileEvent = {
      ts: new Date().toISOString(),
      type: "file.delete",
      runId: this.runId,
      path: relativePath,
    };

    this.watchedFiles.delete(filePath);
    this.fileHashes.delete(filePath);
    this.eventHandler?.(event);
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
      // Use crypto for proper hashing
      const crypto = await import("crypto");
      return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    } catch {
      return undefined;
    }
  }

  /**
   * Get list of files modified during this session
   */
  getModifiedFiles(): Array<{ path: string; hash?: string }> {
    return Array.from(this.watchedFiles).map(filePath => ({
      path: path.relative(this.rootPath, filePath),
      hash: this.fileHashes.get(filePath),
    }));
  }
}
