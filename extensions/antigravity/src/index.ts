/**
 * Google Antigravity Extension for Pi.
 *
 * Provides native integration with Google Antigravity subscriptions in Pi:
 * - Registers the "antigravity" model provider for streaming LLM completions
 * - Dynamic discovery of models (Gemini 3.8 Flash, Gemini 3.1 Pro, Claude 4.6 on Antigravity, etc.)
 * - Slash command `/antigravity` for status, models, test, and workspace tasks
 * - Subagent delegation tool `antigravity_task` for executing complex tasks via Antigravity
 *
 * 100% compliant with Google's Terms of Service:
 * - Operates locally on the user's machine (BYOK / BYO-Subscription)
 * - Uses the official Google Antigravity CLI (`agy`) or official ACP server (`agy_acp_server`)
 * - Preserves official Google authentication and respects all server-side quotas and policies
 * - Zero reverse-engineering or scraping of private web interfaces
 *
 * @module pi-antigravity
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  checkAntigravityStatus,
  findAntigravityBinary,
  runAntigravityTask,
  streamAntigravityPrompt,
} from "./cli-runner.js";
import {
  DEFAULT_ANTIGRAVITY_MODEL,
  KNOWN_ANTIGRAVITY_MODELS,
  resolveAntigravityModels,
} from "./models.js";
import { ACP_REGISTRY_URL, ACP_RELEASE_VERSION } from "./acp-support.js";

export const PROVIDER_NAME = "antigravity";

export default async function (pi: ExtensionAPI) {
  const binaryPath = findAntigravityBinary();
  const models = await resolveAntigravityModels(binaryPath ?? undefined);

  // 1. Register the Antigravity Provider in Pi
  pi.registerProvider(PROVIDER_NAME, {
    name: "Google Antigravity",
    // baseUrl and apiKey are required by Pi to consider a provider "configured"
    // and show its models. This provider never makes HTTP requests — streamSimple
    // spawns the local agy CLI which handles its own Google OAuth.
    baseUrl: "http://localhost:0/antigravity-cli",
    apiKey: "local-cli-auth",
    api: "openai-completions",
    streamSimple: (model, context, options) => {
      return streamAntigravityPrompt(model, context, options);
    },
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: [...m.input],
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      thinkingLevelMap: m.thinkingLevelMap,
      compat: m.compat,
    })),
  });

  // 2. Register `/antigravity` command
  pi.registerCommand("antigravity", {
    description: "Manage and inspect Google Antigravity integration",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "status";
      const rest = parts.slice(1).join(" ").trim();

      switch (subcommand) {
        case "status": {
          ctx.ui.notify("Checking Antigravity status...", "info");
          const status = await checkAntigravityStatus();
          if (status.available && status.authenticated) {
            ctx.ui.notify(
              `Antigravity Connected! Binary: ${status.binaryPath} (${status.models.length} models available)`,
              "info"
            );
          } else if (status.available) {
            ctx.ui.notify(
              `Antigravity found at ${status.binaryPath} but authentication check failed: ${status.error || "Please run 'agy' in terminal to log in"}`,
              "warning"
            );
          } else {
            ctx.ui.notify(
              `Antigravity not found. Error: ${status.error || "Please install the official 'agy' CLI or ACP server"}`,
              "error"
            );
          }
          break;
        }

        case "models": {
          const status = await checkAntigravityStatus();
          const availableModels = status.models.length > 0 ? status.models : KNOWN_ANTIGRAVITY_MODELS.map((m) => m.id);
          const list = availableModels.map((m) => `• ${m}`).join("\n");
          ctx.ui.notify(`Antigravity Models:\n${list}`, "info");
          break;
        }

        case "test": {
          ctx.ui.notify("Running test turn with Google Antigravity...", "info");
          const res = await runAntigravityTask("Respond with: Antigravity connection verified successfully.", {
            model: DEFAULT_ANTIGRAVITY_MODEL,
          });
          if (res.success) {
            ctx.ui.notify(`Test succeeded!\nResponse: ${res.response.trim()}`, "info");
          } else {
            ctx.ui.notify(`Test failed: ${res.response}`, "error");
          }
          break;
        }

        case "task": {
          if (!rest) {
            ctx.ui.notify("Usage: /antigravity task <prompt>", "warning");
            return;
          }
          ctx.ui.notify(`Executing task with Antigravity: "${rest}"...`, "info");
          const res = await runAntigravityTask(rest, {
            cwd: ctx.cwd,
            onUpdate: (delta) => {
              // live progress updates if supported
            },
          });
          if (res.success) {
            ctx.ui.notify(`Antigravity Task Completed:\n${res.response}`, "info");
          } else {
            ctx.ui.notify(`Antigravity Task Failed:\n${res.response}`, "error");
          }
          break;
        }

        default: {
          ctx.ui.notify(
            "Antigravity commands:\n" +
              "/antigravity status  - Check connection & auth\n" +
              "/antigravity models  - List available models\n" +
              "/antigravity test    - Verify connection\n" +
              "/antigravity task <prompt> - Run task via Antigravity",
            "info"
          );
          break;
        }
      }
    },
  });

  // 3. Register `antigravity_task` tool for LLM-driven delegation
  pi.registerTool({
    name: "antigravity_task",
    label: "Google Antigravity Task",
    description:
      "Delegates a coding or reasoning task directly to Google Antigravity, running on your Google subscription.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "The prompt, instruction, or coding task to execute with Google Antigravity.",
      }),
      model: Type.Optional(
        Type.String({
          description: `The Antigravity model to use (default: ${DEFAULT_ANTIGRAVITY_MODEL}).`,
        })
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runAntigravityTask(params.prompt, {
        cwd: ctx.cwd,
        model: params.model || DEFAULT_ANTIGRAVITY_MODEL,
        signal,
        onUpdate: (chunk) => {
          onUpdate?.({
            content: [{ type: "text", text: `[Antigravity Working...]\n${chunk}` }],
            details: {},
          });
        },
      });

      return {
        content: [{ type: "text", text: result.response }],
        details: {
          success: result.success,
          usage: result.usage,
          model: params.model || DEFAULT_ANTIGRAVITY_MODEL,
        },
      };
    },
  });
}
