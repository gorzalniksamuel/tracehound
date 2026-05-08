/**
 * OpenClaw Adapter
 * Specific handling for OpenClaw sessions
 */

import { AgentEvent } from "../types/index.js";

export interface OpenClawSession {
  sessionKey?: string;
  taskId?: string;
  parentAgent?: string;
  childAgents: Array<{ agent: string; taskId: string }>;
  chatSource?: string; // telegram, discord, signal, etc.
}

/**
 * OpenClaw can delegate to coding agents and has structured task metadata.
 * We track:
 * - Main OpenClaw session
 * - Delegated coding-agent subprocesses
 * - Chat source (Discord, Telegram, Signal, WebChat)
 * - Cross-domain actions (repo + email + calendar)
 */
export class OpenClawAdapter {
  private session: OpenClawSession = {
    childAgents: [],
  };
  private eventLog: AgentEvent[] = [];

  /**
   * Parse OpenClaw output for session metadata
   */
  parseOutput(line: string): AgentEvent | null {
    // Detect OpenClaw session start
    const sessionMatch = line.match(/OpenClaw.*Session[:\s]+([a-zA-Z0-9-_]+)/i);
    if (sessionMatch) {
      this.session.sessionKey = sessionMatch[1];
      return {
        ts: new Date().toISOString(),
        type: "session.start",
        runId: "",
        sessionId: sessionMatch[1],
        agent: "openclaw",
        source: "openclaw",
      };
    }

    // Detect chat source
    const chatSourceMatch = line.match(/Source:\s*(discord|telegram|signal|webchat|slack)/i);
    if (chatSourceMatch) {
      this.session.chatSource = chatSourceMatch[1].toLowerCase();
      return {
        ts: new Date().toISOString(),
        type: "process.exec",
        runId: "",
        action: "chat-received",
        platform: chatSourceMatch[1].toLowerCase(),
        agent: "openclaw",
      };
    }

    // Detect coding-agent delegation
    const delegateMatch = line.match(/(coding-agent|coding_agent|code-agent|code_agent).*?using\s+(codex|claude|claude-code|opencode)/i);
    if (delegateMatch) {
      const subAgent = delegateMatch[2] || delegateMatch[1];
      const delegatedTaskId = `openclaw-${Date.now()}`;
      
      this.session.childAgents.push({
        agent: subAgent.toLowerCase(),
        taskId: delegatedTaskId,
      });

      return {
        ts: new Date().toISOString(),
        type: "process.exec",
        runId: "",
        action: "delegate",
        parentAgent: "openclaw",
        childAgent: subAgent.toLowerCase(),
        taskId: delegatedTaskId,
      };
    }

    // Detect Pi planning
    const piMatch = line.match(/Pi\s+(?:planned|planning|thinks|analyzing|selected plan)/i);
    if (piMatch) {
      return {
        ts: new Date().toISOString(),
        type: "process.exec",
        runId: "",
        toolName: "pi-plan",
        agent: "pi",
        parent: "openclaw",
      };
    }

    // Detect tool calls
    const toolCallMatch = line.match(/\[Tool:\s*(\w+)\]/i);
    if (toolCallMatch) {
      return {
        ts: new Date().toISOString(),
        type: "process.exec",
        runId: "",
        toolName: toolCallMatch[1],
        agent: "openclaw",
      };
    }

    // Detect web operations
    const webMatch = line.match(/(web_search|browser_use|web_fetch|fetch_page)\s*[:\-]?\s*(.+)?/i);
    if (webMatch) {
      return {
        ts: new Date().toISOString(),
        type: "network.http",
        runId: "",
        protocol: "https",
        action: webMatch[1],
        query: webMatch[2]?.trim(),
        agent: "openclaw",
      };
    }

    // Detect email/calendar operations
    const crossDomainMatch = line.match(/(send_email|schedule_meeting|calendar_check|inbox_check)/i);
    if (crossDomainMatch) {
      return {
        ts: new Date().toISOString(),
        type: "process.exec",
        runId: "",
        action: crossDomainMatch[1],
        crossDomain: true,
        agent: "openclaw",
      };
    }

    // Detect session end
    const sessionEndMatch = line.match(/OpenClaw.*session.*(ended|complete|finished)/i);
    if (sessionEndMatch) {
      return {
        ts: new Date().toISOString(),
        type: "session.end",
        runId: "",
        sessionId: this.session.sessionKey,
        agent: "openclaw",
      };
    }

    return null;
  }

  /**
   * Get the delegation tree for reporting
   */
  getDelegationTree(): OpenClawSession {
    return { ...this.session };
  }

  /**
   * Get all logged events
   */
  getEvents(): AgentEvent[] {
    return [...this.eventLog];
  }

  /**
   * Enrich metadata with OpenClaw-specific info
   */
  enrichMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    return {
      ...metadata,
      openclaw: {
        sessionKey: this.session.sessionKey,
        chatSource: this.session.chatSource,
        childAgents: this.session.childAgents,
        delegationTree: this.session,
      },
    };
  }

  /**
   * Format delegation tree for display
   */
  formatTree(): string {
    const lines: string[] = [];
    lines.push("OpenClaw Session");
    
    if (this.session.chatSource) {
      lines.push(`  📱 Source: ${this.session.chatSource}`);
    }
    
    if (this.session.sessionKey) {
      lines.push(`  🔑 Session: ${this.session.sessionKey}`);
    }
    
    if (this.session.childAgents.length > 0) {
      lines.push("  🔄 Delegated to:");
      for (const child of this.session.childAgents) {
        lines.push(`    - ${child.agent} (${child.taskId})`);
      }
    }
    
    return lines.join("\n");
  }
}

export default OpenClawAdapter;
