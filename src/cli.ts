#!/usr/bin/env node
/**
 * TraceHound CLI
 * Sniff out what your AI agent is doing
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs/promises";
import * as path from "path";
import { TraceHound } from "./core/tracehound.js";
import { RunStore } from "./core/run-store.js";
import { ReportGenerator } from "./reports/report-generator.js";
import { RunManifest } from "./types/index.js";

const program = new Command();

program
  .name("tracehound")
  .description("Sniff out what your AI agent is doing")
  .version("0.1.0");

program
  .command("run")
  .description("Record an agent session")
  .option("-n, --name <name>", "Assign a name to this run")
  .option("-a, --agent <agent>", "Specify agent type (codex, claude, opencode, openclaw)")
  .option("-m, --mode <mode>", "Recording mode (record, warn, enforce)", "record")
  .argument("<command...>", "Agent command to run")
  .action(async (args: string[], options) => {
    const agentCommand = args.join(" ").trim();
    
    if (!agentCommand) {
      console.error(chalk.red("Error: No agent command specified"));
      process.exit(1);
    }

    console.log(chalk.blue("🐕 TraceHound"), "- Sniffing out agent behavior...\n");
    
    const tracehound = new TraceHound({
      name: options.name,
      agent: options.agent,
      mode: options.mode,
    });

    try {
      const result = await tracehound.run(agentCommand);
      
      console.log("\n" + chalk.green("✅ Recording complete!"));
      console.log(chalk.gray(`Run ID: ${result.runId}`));
      console.log(chalk.gray(`Duration: ${formatDuration(result.durationMs)}`));
      console.log(chalk.gray(`View report: tracehound report ${result.runId}`));
      
      if (result.warnings.length > 0) {
        console.log("\n" + chalk.yellow("⚠️  Warnings:"));
        result.warnings.forEach(w => console.log(chalk.yellow(`  - ${w}`)));
      }
      
    } catch (error: any) {
      console.error(chalk.red("\n❌ Recording failed:"), error.message || error);
      process.exit(1);
    }
  });

program
  .command("report")
  .description("Generate a report from a recorded session")
  .argument("[run-id]", "Run ID (defaults to latest)")
  .option("--html", "Generate HTML report")
  .option("--json", "Output as JSON")
  .action(async (runId: string | undefined, options: { html?: boolean; json?: boolean }) => {
    const store = new RunStore();
    const targetRunId = runId || await getLatestRunId();
    
    if (!targetRunId) {
      console.error(chalk.red("No runs found. Run 'tracehound run' first."));
      process.exit(1);
    }

    const manifestPath = path.join(
      process.cwd(), 
      ".tracehound", 
      "runs", 
      targetRunId, 
      "manifest.json"
    );
    
    let manifest: RunManifest;
    try {
      const data = await fs.readFile(manifestPath, "utf-8");
      manifest = JSON.parse(data) as RunManifest;
    } catch (error) {
      console.error(chalk.red(`Run not found: ${targetRunId}`));
      process.exit(1);
    }

    const generator = new ReportGenerator(manifest);
    
    if (options.json) {
      console.log(JSON.stringify(manifest, null, 2));
    } else if (options.html) {
      const htmlPath = await generator.generateHtml();
      console.log(chalk.green(`HTML report: ${htmlPath}`));
    } else {
      const report = generator.generateMarkdown();
      console.log(report);
    }
  });

program
  .command("list")
  .description("List recorded sessions")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    const runs = await listRuns();
    
    if (options.json) {
      console.log(JSON.stringify(runs, null, 2));
      return;
    }
    
    if (runs.length === 0) {
      console.log(chalk.gray("No recorded runs found."));
      return;
    }
    
    console.log(chalk.bold("\nRecorded Sessions:\n"));
    runs.forEach((run, i) => {
      const indicator = i === 0 ? chalk.cyan("→ ") : "  ";
      const date = new Date(run.timestamp).toLocaleString();
      const agentName = run.agent ? chalk.gray(`[${run.agent}]`) : "";
      console.log(`${indicator}${chalk.white(run.id)} ${chalk.gray(date)} ${agentName}`);
      if (run.name) {
        console.log(`     ${chalk.gray(run.name)}`);
      }
    });
    console.log();
  });

program
  .command("replay")
  .description("Replay a recorded session")
  .argument("<run-id>", "Run ID to replay")
  .action(async (runId: string) => {
    console.log(chalk.blue("Replaying session...") + chalk.gray(` (${runId})`));
    console.log(chalk.gray("Replay feature coming soon!"));
  });

program
  .command("compare")
  .description("Compare two recorded sessions")
  .argument("<run-id-1>", "First run ID")
  .argument("<run-id-2>", "Second run ID")
  .action(async (runId1: string, runId2: string) => {
    console.log(chalk.blue("Comparing sessions..."));
    console.log(chalk.gray("Comparison feature coming soon!"));
  });

async function getLatestRunId(): Promise<string | null> {
  try {
    const runsPath = path.join(process.cwd(), ".tracehound", "runs");
    const entries = await fs.readdir(runsPath);
    const runs = entries
      .filter(e => !e.startsWith("."))
      .sort()
      .reverse();
    return runs[0] || null;
  } catch {
    return null;
  }
}

async function listRuns(): Promise<Array<{ id: string; name?: string; timestamp: string; agent?: string }>> {
  try {
    const runsPath = path.join(process.cwd(), ".tracehound", "runs");
    const entries = await fs.readdir(runsPath);
    const runs: Array<{ id: string; name?: string; timestamp: string; agent?: string }> = [];
    
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      
      const manifestPath = path.join(runsPath, entry, "manifest.json");
      try {
        const data = await fs.readFile(manifestPath, "utf-8");
        const manifest: RunManifest = JSON.parse(data);
        runs.push({
          id: manifest.run.id,
          name: manifest.run.name,
          timestamp: manifest.run.timestamp,
          agent: manifest.agent.name,
        });
      } catch {
        // Skip invalid manifests
      }
    }
    
    return runs.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  } catch {
    return [];
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 
    ? `${minutes}m ${remainingSeconds}s`
    : `${seconds}s`;
}

// Handle unhandled arguments
if (process.argv.length <= 2) {
  program.help();
}

program.parse();
