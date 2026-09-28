/**
 * Types and interfaces for the Antigravity extension for Pi.
 */

import type { Api, Model, SimpleStreamOptions, TranscriptContext, Usage } from "@earendil-works/pi-ai";

export type AntigravityThinkingLevel = "off" | "low" | "medium" | "high";

export interface AntigravityModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Readonly<Record<string, string | null>>;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
  };
}

export interface AgyInitEvent {
  event: "init";
  conversation_id: string;
  init: {
    model?: string;
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
}

export interface AgyStepUpdateEvent {
  event: "step_update";
  step_update: {
    conversation_id?: string;
    step_index?: number;
    state: "ACTIVE" | "DONE" | "RUNNING";
    step_type: "user_input" | "agent_response" | "system_message" | "tool";
    text_delta?: string;
    duration_seconds?: number;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens: number;
    };
    tool_name?: string;
    tool_info?: Record<string, unknown>;
  };
}

export interface AgyResultEvent {
  event: "result";
  result: {
    conversation_id: string;
    status: "SUCCESS" | "ERROR";
    response: string;
    duration_seconds: number;
    num_turns?: number;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens: number;
    };
    error?: string;
  };
}

export type AgyStreamEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent | { event: string; [key: string]: unknown };

export interface AgyStatus {
  available: boolean;
  binaryPath: string | null;
  version?: string;
  source: "local-cli" | "acp-binary" | "not-found";
  authenticated: boolean;
  accountEmail?: string;
  models: string[];
  error?: string;
}
