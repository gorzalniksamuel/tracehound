/**
 * Network Proxy
 * Simple HTTP proxy for capturing network requests
 */

import http from "http";
import https from "https";
import { EventEmitter } from "events";
import { NetworkEvent, AgentEvent } from "../types/index.js";

export class NetworkProxy extends EventEmitter {
  private proxy?: http.Server;
  private runId: string = "";
  private port: number = 0;
  private eventHandler?: (event: AgentEvent) => void;

  async start(
    runId: string,
    onEvent: (event: AgentEvent) => void
  ): Promise<{ port: number; url: string }> {
    this.runId = runId;
    this.eventHandler = onEvent;
    
    return new Promise((resolve, reject) => {
      this.proxy = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Find available port
      this.proxy.listen(0, "127.0.0.1", () => {
        const address = this.proxy?.address();
        if (address && typeof address === "object") {
          this.port = address.port;
          resolve({
            port: this.port,
            url: `http://127.0.0.1:${this.port}`,
          });
        } else {
          reject(new Error("Failed to get proxy address"));
        }
      });

      this.proxy.on("error", (err) => {
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.proxy?.close(() => resolve());
      setTimeout(resolve, 100);
    });
  }

  getProxyUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const targetUrl = req.url || "";
    const parsedUrl = new URL(targetUrl.startsWith("http") ? targetUrl : `http://${targetUrl}`);
    
    // Log the request
    const event: NetworkEvent = {
      ts: new Date().toISOString(),
      type: "network.http",
      runId: this.runId,
      protocol: parsedUrl.protocol,
      host: parsedUrl.hostname,
      ip: undefined,
      port: parseInt(parsedUrl.port) || (parsedUrl.protocol === "https:" ? 443 : 80),
      method: req.method || "GET",
      path: parsedUrl.pathname + parsedUrl.search,
    };
    
    this.eventHandler?.(event);
    this.emit("request", event);

    // Forward the request
    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: parsedUrl.hostname,
      },
    };

    const protocol = parsedUrl.protocol === "https:" ? https : http;
    
    const proxyReq = protocol.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      res.writeHead(502);
      res.end(`Proxy Error: ${err.message}`);
    });

    req.pipe(proxyReq);
  }
}

/**
 * Passive network monitor using lsof/netstat
 */
export class PassiveNetworkMonitor extends EventEmitter {
  private interval?: NodeJS.Timeout;
  private runId: string = "";
  private seenConnections = new Set<string>();

  async start(
    runId: string,
    onEvent: (event: AgentEvent) => void
  ): Promise<void> {
    this.runId = runId;
    
    // Poll for new connections every 2 seconds
    this.interval = setInterval(async () => {
      try {
        const connections = await this.getConnections();
        
        for (const conn of connections) {
          const key = `${conn.host}:${conn.port}`;
          if (!this.seenConnections.has(key)) {
            this.seenConnections.add(key);
            
            const event: NetworkEvent = {
              ts: new Date().toISOString(),
              type: "network.http",
              runId,
              protocol: "tcp",
              host: conn.host,
              ip: undefined,
              port: conn.port,
              method: "CONNECT",
              path: "/",
            };
            
            onEvent(event);
          }
        }
      } catch {
        // Ignore errors
      }
    }, 2000);
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
    }
    this.seenConnections.clear();
  }

  private async getConnections(): Promise<Array<{ host: string; port: number }>> {
    const connections: Array<{ host: string; port: number }> = [];
    
    try {
      const { execAsync } = await import("../utils/exec.js");
      
      // Try lsof (macOS/Linux)
      try {
        const { stdout } = await execAsync("lsof -iTCP -n -P 2>/dev/null | grep ESTABLISHED | awk '{print $9}'");
        for (const line of stdout.split("\n")) {
          const match = line.match(/->([\d.]+):(\d+)/);
          if (match) {
            connections.push({ host: match[1], port: parseInt(match[2]) });
          }
        }
      } catch {
        // lsof failed
      }
    } catch {
      // Can't load utils
    }
    
    return connections;
  }
}
