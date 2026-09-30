/**
 * CLI Runner for Google Antigravity.
 *
 * Spawns the official local `agy.exe` binary in headless stream-json mode,
 * piping input via stdin and streaming NDJSON events to Pi's AssistantMessageEventStream.
 *
 * This uses the user's existing local Google authentication and active subscription,
 * guaranteeing 100% compliance with Google's Terms of Service.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import type { AgyStatus, AgyStreamEvent } from "./types.js";
import { resolveAgyModelId } from "./models.js";

/**
 * Searches for the official Google Antigravity CLI executable.
 */
export function findAntigravityBinary(): string | null {
  if (process.env.AGY_PATH && fs.existsSync(process.env.AGY_PATH)) {
    return process.env.AGY_PATH;
  }

  const userHome = os.homedir();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    candidates.push(
      path.join(userHome, ".gemini", "bin", "agy.exe"),
      path.join(userHome, "AppData", "Local", "Google", "Antigravity", "bin", "agy.exe"),
      path.join(userHome, "bin", "agy.exe")
    );
  } else {
    candidates.push(
      path.join(userHome, ".gemini", "bin", "agy"),
      path.join(userHome, "bin", "agy"),
      "/usr/local/bin/agy",
      "/opt/google/antigravity/bin/agy"
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fall back to PATH lookup
  return "agy";
}

import { findAcpServerBinary, isAcpAuthenticated } from "./acp-support.js";
import { AcpSession } from "./acp-client.js";

/**
 * Checks Antigravity CLI and ACP server status, version, and authentication.
 */
export async function checkAntigravityStatus(): Promise<AgyStatus> {
  const acpBin = findAcpServerBinary();
  const acpAuth = isAcpAuthenticated();
  const agyCli = findAntigravityBinary();
  const binaryPath = acpAuth && acpBin ? acpBin.executablePath : (agyCli || acpBin?.executablePath);

  if (!binaryPath) {
    return {
      available: false,
      binaryPath: null,
      source: "not-found",
      authenticated: false,
      models: [],
      error: "Google Antigravity not found. Install official ACP server or agy CLI.",
    };
  }

  // Probe models using agy CLI or known models
  if (agyCli) {
    return new Promise<AgyStatus>((resolve) => {
      const child = spawn(agyCli, ["models"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const timeout = setTimeout(() => {
        child.kill();
        resolve({
          available: true,
          binaryPath,
          source: acpBin ? "acp-binary" : "local-cli",
          authenticated: true,
          models: [],
          error: "Timeout checking Antigravity models.",
        });
      }, 6000);

      child.on("error", (err) => {
        clearTimeout(timeout);
        resolve({
          available: Boolean(acpBin),
          binaryPath,
          source: acpBin ? "acp-binary" : "not-found",
          authenticated: Boolean(acpBin),
          models: [],
          error: `Could not launch '${agyCli}': ${err.message}`,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          const models = stdout
            .split(/\r?\n/)
            .map((line) => line.split(/\t+|\s{2,}/)[0]?.trim())
            .filter((m): m is string => Boolean(m && !m.startsWith("Fetching")));

          resolve({
            available: true,
            binaryPath,
            source: acpBin ? "acp-binary" : "local-cli",
            authenticated: true,
            models,
          });
        } else {
          resolve({
            available: true,
            binaryPath,
            source: acpBin ? "acp-binary" : "local-cli",
            authenticated: Boolean(acpBin),
            models: [],
            error: (stderr || stdout || `Process exited with code ${code}`).trim(),
          });
        }
      });
    });
  }

  return {
    available: true,
    binaryPath,
    source: "acp-binary",
    authenticated: true,
    models: [],
  };
}

/**
 * Formats transcript messages into a concise single prompt for the completion runner.
 */
export function formatTranscriptForPrompt(context: TranscriptContext): string {
  const normalized = collapseSystemMessages(context);
  const systemPrompt = getCurrentSystemPrompt(normalized.messages);

  const parts: string[] = [];

  // Preamble enforcing completion-mode behavior
  parts.push(
    "Instructions: You are acting as a direct AI coding assistant in Pi Agent. Provide clear, accurate text and code completions directly in your response. Do not call local filesystem or bash execution tools."
  );

  if (systemPrompt && systemPrompt.trim().length > 0) {
    parts.push(`\n[System Instructions]\n${systemPrompt.trim()}`);
  }

  // Filter messages excluding initial system message
  const userTurns = normalized.messages.filter((m) => m.role !== "system");

  if (userTurns.length === 1 && typeof userTurns[0].content === "string") {
    // Single prompt - keep it clean and direct
    parts.push(`\n${userTurns[0].content}`);
  } else {
    parts.push("\n[Conversation History]");
    for (const msg of userTurns) {
      const role = msg.role === "user" ? "User" : "Assistant";
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .map((b) => {
            if (b.type === "text") return b.text;
            if (b.type === "toolCall") return `[Tool Call: ${b.name}]`;
            if (b.type === "toolResult") {
              const resText = Array.isArray(b.content)
                ? b.content.map((c) => (c.type === "text" ? c.text : "[Image]")).join("\n")
                : "";
              return `[Tool Result: ${resText}]`;
            }
            return "";
          })
          .join("\n");
      }
      parts.push(`\n${role}:\n${text.trim()}`);
    }
  }

  return parts.join("\n");
}

/**
 * Streams completion from Google Antigravity (ACP Server or CLI).
 */
export function streamAntigravityPrompt(
  model: Model<any>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const acpBin = findAcpServerBinary();
  const useAcp = Boolean(acpBin && isAcpAuthenticated());
  const binaryPath = useAcp && acpBin ? acpBin.executablePath : (findAntigravityBinary() || "agy");

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };

  (async () => {
    try {
      if (options?.signal?.aborted) {
        output.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        return;
      }

      // 1. Send start event
      stream.push({ type: "start", partial: output });

      // 2. Prepare prompt text
      const promptText = formatTranscriptForPrompt(context);

      // Route A: Official ACP server (identical to Zed & T3 Code)
      if (useAcp && acpBin) {
        let textIndex = -1;
        let thinkingIndex = -1;

        const session = await AcpSession.create({
          executablePath: acpBin.executablePath,
          harnessPath: acpBin.harnessPath,
          mode: "default",
          model: model.id,
          signal: options?.signal,
        });

        await session.prompt(promptText, {
          onThoughtDelta: (delta) => {
            if (thinkingIndex === -1) {
              thinkingIndex = output.content.length;
              output.content.push({ type: "thinking", thinking: "" });
              stream.push({
                type: "thinking_start",
                contentIndex: thinkingIndex,
                partial: output,
              });
            }
            const block = output.content[thinkingIndex];
            if (block && block.type === "thinking") {
              block.thinking += delta;
              stream.push({
                type: "thinking_delta",
                contentIndex: thinkingIndex,
                delta,
                partial: output,
              });
            }
          },
          onTextDelta: (delta) => {
            // If thinking was open and text begins, finalize thinking block
            if (thinkingIndex !== -1 && textIndex === -1) {
              const thinkBlock = output.content[thinkingIndex];
              if (thinkBlock && thinkBlock.type === "thinking") {
                stream.push({
                  type: "thinking_end",
                  contentIndex: thinkingIndex,
                  content: thinkBlock.thinking,
                  partial: output,
                });
              }
            }
            if (textIndex === -1) {
              textIndex = output.content.length;
              output.content.push({ type: "text", text: "" });
              stream.push({
                type: "text_start",
                contentIndex: textIndex,
                partial: output,
              });
            }
            const block = output.content[textIndex];
            if (block && block.type === "text") {
              block.text += delta;
              stream.push({
                type: "text_delta",
                contentIndex: textIndex,
                delta,
                partial: output,
              });
            }
          },
          onUsage: (usage) => {
            output.usage.input = usage.inputTokens;
            output.usage.output = usage.outputTokens;
            output.usage.totalTokens = usage.totalTokens;
          },
        });

        session.close();

        // Close thinking if it was never closed by text
        if (thinkingIndex !== -1 && textIndex === -1) {
          const thinkBlock = output.content[thinkingIndex];
          if (thinkBlock && thinkBlock.type === "thinking") {
            stream.push({
              type: "thinking_end",
              contentIndex: thinkingIndex,
              content: thinkBlock.thinking,
              partial: output,
            });
          }
        }
        // Close text if opened
        if (textIndex !== -1) {
          const textBlock = output.content[textIndex];
          if (textBlock && textBlock.type === "text") {
            stream.push({
              type: "text_end",
              contentIndex: textIndex,
              content: textBlock.text,
              partial: output,
            });
          }
        } else if (thinkingIndex === -1) {
          // If neither thinking nor text was pushed, emit empty text block
          const emptyIdx = output.content.length;
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: emptyIdx, partial: output });
          stream.push({ type: "text_end", contentIndex: emptyIdx, content: "", partial: output });
        }

        output.stopReason = "stop";
      } else {
        // Route B: Official Google Antigravity CLI runner
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex, partial: output });

        const agyModelId = resolveAgyModelId(model.id, options?.reasoning);
        const args = [
          "--model",
          agyModelId,
          "--output-format",
          "stream-json",
          "--disable-slash-commands",
        ];

        const child = spawn(binaryPath, args, {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });

        if (options?.signal) {
          const abortHandler = () => child.kill();
          options.signal.addEventListener("abort", abortHandler, { once: true });
          child.on("close", () => {
            options.signal?.removeEventListener("abort", abortHandler);
          });
        }

        child.stdin.write(promptText, "utf8");
        child.stdin.end();

        const rl = readline.createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });

        let stderrOutput = "";
        child.stderr.on("data", (chunk) => {
          stderrOutput += chunk.toString();
        });

        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as AgyStreamEvent;

            if (parsed.event === "step_update" && "step_update" in parsed) {
              const step = parsed.step_update;

              if (step.text_delta) {
                const currentBlock = output.content[contentIndex];
                if (currentBlock && currentBlock.type === "text") {
                  currentBlock.text += step.text_delta;
                  stream.push({
                    type: "text_delta",
                    contentIndex,
                    delta: step.text_delta,
                    partial: output,
                  });
                }
              }

              if (step.usage) {
                output.usage.input = step.usage.input_tokens || output.usage.input;
                output.usage.output = step.usage.output_tokens || output.usage.output;
                output.usage.cacheRead = step.usage.cache_read_tokens || 0;
                output.usage.totalTokens = step.usage.total_tokens || output.usage.totalTokens;
              }
            } else if (parsed.event === "result" && "result" in parsed) {
              const res = parsed.result;
              if (res.usage) {
                output.usage.input = res.usage.input_tokens || output.usage.input;
                output.usage.output = res.usage.output_tokens || output.usage.output;
                output.usage.cacheRead = res.usage.cache_read_tokens || 0;
                output.usage.totalTokens = res.usage.total_tokens || output.usage.totalTokens;
              }
              if (res.status === "ERROR") {
                output.stopReason = "error";
                output.errorMessage = res.error || "Antigravity execution failed";
              }
            }
          } catch {
            // non-json line
          }
        }

        await new Promise<void>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code) => {
            if (options?.signal?.aborted) {
              output.stopReason = "aborted";
              resolve();
              return;
            }
            if (code !== 0 && output.stopReason !== "error") {
              output.stopReason = "error";
              output.errorMessage = stderrOutput.trim() || `Antigravity CLI exited with code ${code}`;
            } else if (output.stopReason === "pending") {
              output.stopReason = "stop";
            }
            resolve();
          });
        });

        // Finalize text block for CLI runner
        const finalBlock = output.content[contentIndex];
        if (finalBlock && finalBlock.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex,
            content: finalBlock.text,
            partial: output,
          });
        }
      }


      if (output.stopReason === "error") {
        stream.push({ type: "error", reason: "error", error: output });
      } else {
        stream.push({ type: "done", reason: output.stopReason, message: output });
      }
      stream.end();
    } catch (err) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = err instanceof Error ? err.message : String(err);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

/**
 * Runs a standalone Antigravity task in the workspace.
 * Uses official ACP session (identical to Zed & T3 Code) or agy CLI with yolo permissions.
 */
export async function runAntigravityTask(
  prompt: string,
  options?: {
    model?: string;
    cwd?: string;
    onUpdate?: (delta: string) => void;
    signal?: AbortSignal;
  }
): Promise<{ success: boolean; response: string; usage?: { input: number; output: number; total: number } }> {
  if (options?.signal?.aborted) {
    return { success: false, response: "Task aborted." };
  }

  const acpBin = findAcpServerBinary();
  const useAcp = Boolean(acpBin && isAcpAuthenticated());

  // Route A: Official ACP server with "yolo" full-access permissions (T3 Code / Zed pattern)
  if (useAcp && acpBin) {
    try {
      const session = await AcpSession.create({
        executablePath: acpBin.executablePath,
        harnessPath: acpBin.harnessPath,
        cwd: options?.cwd || process.cwd(),
        mode: "yolo",
        model: options?.model,
        signal: options?.signal,
      });

      const result = await session.prompt(prompt, {
        onTextDelta: options?.onUpdate,
      });

      session.close();
      return {
        success: true,
        response: result.response || "Task completed successfully via ACP.",
        usage: {
          input: result.usage.inputTokens,
          output: result.usage.outputTokens,
          total: result.usage.totalTokens,
        },
      };
    } catch (err) {
      return {
        success: false,
        response: `ACP execution error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Route B: Official Antigravity CLI runner
  const binaryPath = findAntigravityBinary() || "agy";
  const agyModelId = options?.model ? resolveAgyModelId(options.model) : undefined;
  const args = [
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--dangerously-skip-permissions",
  ];

  if (agyModelId) {
    args.push("--model", agyModelId);
  }

  const child = spawn(binaryPath, args, {
    cwd: options?.cwd || process.cwd(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (options?.signal) {
    const abortHandler = () => child.kill();
    options.signal.addEventListener("abort", abortHandler, { once: true });
    child.on("close", () => {
      options.signal?.removeEventListener("abort", abortHandler);
    });
  }

  child.stdin.write(prompt, "utf8");
  child.stdin.end();

  let fullResponse = "";
  let usage = { input: 0, output: 0, total: 0 };
  let errorMsg = "";

  child.stderr.on("data", (chunk) => {
    errorMsg += chunk.toString();
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AgyStreamEvent;
      if (parsed.event === "step_update" && "step_update" in parsed) {
        if (parsed.step_update.text_delta) {
          fullResponse += parsed.step_update.text_delta;
          options?.onUpdate?.(parsed.step_update.text_delta);
        }
        if (parsed.step_update.usage) {
          usage = {
            input: parsed.step_update.usage.input_tokens,
            output: parsed.step_update.usage.output_tokens,
            total: parsed.step_update.usage.total_tokens,
          };
        }
      } else if (parsed.event === "result" && "result" in parsed) {
        if (parsed.result.response) {
          fullResponse = parsed.result.response;
        }
        if (parsed.result.usage) {
          usage = {
            input: parsed.result.usage.input_tokens,
            output: parsed.result.usage.output_tokens,
            total: parsed.result.usage.total_tokens,
          };
        }
      }
    } catch {
      // non-json
    }
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

  return {
    success: exitCode === 0,
    response: fullResponse || (exitCode === 0 ? "Task completed successfully." : errorMsg),
    usage,
  };
}

