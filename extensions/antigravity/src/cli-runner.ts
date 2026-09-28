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

/**
 * Checks Antigravity CLI status, version, and authentication.
 */
export async function checkAntigravityStatus(): Promise<AgyStatus> {
  const binaryPath = findAntigravityBinary();
  if (!binaryPath) {
    return {
      available: false,
      binaryPath: null,
      source: "not-found",
      authenticated: false,
      models: [],
      error: "Google Antigravity CLI ('agy') not found on this machine.",
    };
  }

  return new Promise<AgyStatus>((resolve) => {
    const child = spawn(binaryPath, ["models"], {
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
        available: false,
        binaryPath,
        source: "local-cli",
        authenticated: false,
        models: [],
        error: "Timeout checking Antigravity status.",
      });
    }, 6000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        available: false,
        binaryPath,
        source: "not-found",
        authenticated: false,
        models: [],
        error: `Could not launch '${binaryPath}': ${err.message}`,
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
          source: "local-cli",
          authenticated: true,
          models,
        });
      } else {
        const errorMsg = stderr || stdout || `Process exited with code ${code}`;
        const isAuthIssue =
          errorMsg.includes("login") ||
          errorMsg.includes("authenticate") ||
          errorMsg.includes("token");

        resolve({
          available: true,
          binaryPath,
          source: "local-cli",
          authenticated: !isAuthIssue,
          models: [],
          error: errorMsg.trim(),
        });
      }
    });
  });
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
 * Streams completion from Google Antigravity CLI via stream-json.
 */
export function streamAntigravityPrompt(
  model: Model<any>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const binaryPath = findAntigravityBinary() || "agy";

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
      // 1. Send start event
      stream.push({ type: "start", partial: output });

      // 2. Prepare prompt text
      const promptText = formatTranscriptForPrompt(context);

      // 3. Build spawn arguments — resolve the actual agy model ID from
      //    the base model + Pi's reasoning level (e.g. gemini-3.8-flash + high → gemini-3.8-flash-high)
      const agyModelId = resolveAgyModelId(model.id, options?.reasoning);
      const args = [
        "--model",
        agyModelId,
        "--output-format",
        "stream-json",
      ];

      // 4. Spawn child process
      const child = spawn(binaryPath, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Handle abort signal
      if (options?.signal) {
        const abortHandler = () => {
          child.kill();
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
        child.on("close", () => {
          options.signal?.removeEventListener("abort", abortHandler);
        });
      }

      // Write prompt to stdin and close stdin
      child.stdin.write(promptText, "utf8");
      child.stdin.end();

      // Ensure content block exists for streaming text
      output.content.push({ type: "text", text: "" });
      const contentIndex = 0;
      stream.push({ type: "text_start", contentIndex, partial: output });

      // Process NDJSON line by line
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
          // Non-JSON line (ignore or log)
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

      // Finalize text block
      const finalBlock = output.content[contentIndex];
      if (finalBlock && finalBlock.type === "text") {
        stream.push({
          type: "text_end",
          contentIndex,
          content: finalBlock.text,
          partial: output,
        });
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
 * Allows Pi's agent to delegate tasks directly to Google Antigravity.
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
  const binaryPath = findAntigravityBinary() || "agy";
  const agyModelId = options?.model ? resolveAgyModelId(options.model) : undefined;
  const args = ["--output-format", "stream-json"];

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
