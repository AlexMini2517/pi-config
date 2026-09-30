/**
 * Native Agent Client Protocol (ACP) Client for Google Antigravity.
 *
 * Implements the official JSON-RPC 2.0 communication over stdio with Google's
 * `agy_acp_server`, identical to the integration used by Zed and T3 Code.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

export interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  totalTokens: number;
}

export interface AcpPromptResult {
  response: string;
  stopReason: string;
  usage: AcpUsage;
}

export interface AcpClientOptions {
  executablePath: string;
  harnessPath: string;
  cwd?: string;
  model?: string;
  mode?: "yolo" | "auto_edit" | "default";
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export class AcpSession {
  private child: ChildProcess;
  private pendingRequests = new Map<
    number | string,
    { resolve: (res: any) => void; reject: (err: any) => void }
  >();
  private nextRequestId = 1;
  private sessionId: string | null = null;
  private closed = false;
  private configOptions: any[] = [];

  private constructor(child: ChildProcess) {
    this.child = child;
    this.setupReader();
  }

  static async create(options: AcpClientOptions): Promise<AcpSession> {
    const userHome = os.homedir();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      ANTIGRAVITY_HARNESS_PATH: options.harnessPath,
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      PYTHONUNBUFFERED: "1",
      ELECTRON_RUN_AS_NODE: "1",
      GEMINI_HOME: path.join(userHome, ".gemini"),
    };

    const args = process.platform === "linux" ? ["--uid="] : [];
    const child = spawn(options.executablePath, args, {
      cwd: options.cwd || process.cwd(),
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session = new AcpSession(child);

    if (options.signal) {
      options.signal.addEventListener("abort", () => session.close(), { once: true });
    }

    // 1. Send initialize (standard ACP schema)
    await session.sendRequest("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "pi-agent", version: "1.0.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    // 2. Authenticate using user's local Google account (T3 Code & Zed pattern)
    try {
      await session.sendRequest("authenticate", {
        methodId: "oauth-personal",
      });
    } catch {
      // Ignored if already authenticated or method differs
    }

    // 3. Create ACP session
    const sessionRes = await session.sendRequest("session/new", {
      cwd: options.cwd || process.cwd(),
      mcpServers: [],
    });
    session.sessionId = sessionRes.sessionId;
    session.configOptions = sessionRes.configOptions || [];

    // 4. Set permission mode (e.g. "yolo" for autonomous edits, or "default")
    if (options.mode) {
      await session.setMode(options.mode);
    }

    // 5. Set model if specified
    if (options.model) {
      await session.setModel(options.model);
    }

    return session;
  }

  /**
   * Sets the execution permission mode via session/set_config_option or session/set_mode.
   */
  async setMode(mode: string): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.sendRequest("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "mode",
        value: mode,
      });
    } catch {
      try {
        await this.sendRequest("session/set_mode", {
          sessionId: this.sessionId,
          mode,
          modeId: mode,
        });
      } catch {
        // Ignored
      }
    }
  }

  /**
   * Sets the active model via session/set_config_option.
   */
  async setModel(modelId: string): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.sendRequest("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "model",
        value: modelId,
      });
    } catch {
      // Ignored
    }
  }

  private setupReader() {
    const rl = readline.createInterface({
      input: this.child.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed);
        this.handleMessage(msg);
      } catch {
        // Non-JSON output (ignore)
      }
    });

    this.child.on("close", () => {
      this.closed = true;
      for (const req of this.pendingRequests.values()) {
        req.reject(new Error("ACP server process closed"));
      }
      this.pendingRequests.clear();
    });

    this.child.on("error", (err) => {
      for (const req of this.pendingRequests.values()) {
        req.reject(err);
      }
      this.pendingRequests.clear();
    });
  }

  private handleMessage(msg: any) {
    // Response to a request
    if (msg.id !== undefined && !msg.method) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Inbound request from server (e.g., session/request_permission)
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      // Auto-approve permission (official ACP response outcome format)
      const options = msg.params?.options || [];
      const allowOption =
        options.find((o: any) => o.kind === "allow_always") ||
        options.find((o: any) => o.kind === "allow_once") ||
        options[0];

      const optionId = allowOption?.optionId || "allow_once";
      this.sendResponse(msg.id, {
        outcome: {
          outcome: "selected",
          optionId,
        },
      });
      return;
    }

    // Notifications (session/update) are handled by active prompt listeners
    if (this.activePromptListener) {
      this.activePromptListener(msg);
    }
  }

  private activePromptListener: ((msg: any) => void) | null = null;

  async prompt(
    text: string,
    callbacks?: {
      onTextDelta?: (delta: string) => void;
      onThoughtDelta?: (delta: string) => void;
      onToolCall?: (toolCall: any) => void;
      onUsage?: (usage: AcpUsage) => void;
    }
  ): Promise<AcpPromptResult> {
    if (!this.sessionId) {
      throw new Error("No active ACP session");
    }

    let fullResponse = "";
    const usage: AcpUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    const promptId = this.nextRequestId++;

    return new Promise<AcpPromptResult>((resolve, reject) => {
      this.activePromptListener = (msg: any) => {
        if (msg.method === "session/update" && msg.params?.sessionId === this.sessionId) {
          const update = msg.params.update;
          if (!update) return;

          if (update.sessionUpdate === "agent_message_chunk") {
            const chunk =
              (typeof update.content === "string" ? update.content : update.content?.text) || "";
            if (chunk) {
              fullResponse += chunk;
              callbacks?.onTextDelta?.(chunk);
            }
          } else if (update.sessionUpdate === "agent_thought_chunk") {
            const chunk =
              (typeof update.content === "string" ? update.content : update.content?.text) || "";
            if (chunk) {
              callbacks?.onThoughtDelta?.(chunk);
            }
          } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            callbacks?.onToolCall?.(update.toolCall);
          } else if (update.sessionUpdate === "usage" && update.usage) {
            usage.inputTokens = update.usage.inputTokens || usage.inputTokens;
            usage.outputTokens = update.usage.outputTokens || usage.outputTokens;
            usage.totalTokens = update.usage.totalTokens || usage.totalTokens;
            callbacks?.onUsage?.(usage);
          }
        }
      };

      this.pendingRequests.set(promptId, {
        resolve: (result) => {
          this.activePromptListener = null;
          resolve({
            response: fullResponse,
            stopReason: result?.stopReason || "end_turn",
            usage,
          });
        },
        reject: (err) => {
          this.activePromptListener = null;
          reject(err);
        },
      });

      this.sendRaw({
        jsonrpc: "2.0",
        id: promptId,
        method: "session/prompt",
        params: {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text }],
        },
      });
    });
  }

  private sendRequest(method: string, params: any): Promise<any> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  private sendResponse(id: number | string, result: any) {
    this.sendRaw({ jsonrpc: "2.0", id, result });
  }

  private sendRaw(data: any) {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) {
      return;
    }
    this.child.stdin.write(JSON.stringify(data) + "\n", "utf8");
  }

  close() {
    if (this.closed) return;
    this.closed = true;

    if (this.sessionId && this.child.stdin && !this.child.stdin.destroyed) {
      try {
        this.sendRaw({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: this.sessionId },
        });
      } catch {}
    }

    try {
      this.child.kill();
    } catch {}
  }
}
