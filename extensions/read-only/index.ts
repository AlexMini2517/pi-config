import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MUTATING_TOOLS = new Set(["edit", "write", "bash", "powershell"]);
const READ_ONLY_BUILTINS = ["read", "grep", "find", "ls"];
const STATUS_KEY = "read-only";

export default function (pi: ExtensionAPI) {
	let isReadOnly = process.env.PI_READ_ONLY === "1";
	let savedTools: string[] = [];

	function applyReadOnlyTools() {
		savedTools = pi.getActiveTools();
		const all = pi.getAllTools().map((t) => t.name);
		const readTools = [
			...READ_ONLY_BUILTINS.filter((name) => all.includes(name)),
			...all.filter((name) => !MUTATING_TOOLS.has(name) && !READ_ONLY_BUILTINS.includes(name)),
		];
		pi.setActiveTools([...new Set(readTools)]);
	}

	function restoreTools() {
		if (savedTools.length > 0) {
			pi.setActiveTools(savedTools);
		} else {
			const all = pi.getAllTools().map((t) => t.name);
			const defaultTools = all.filter((t) => t !== "grep" && t !== "find" && t !== "ls");
			pi.setActiveTools(defaultTools);
		}
	}

	function updateStatus(ctx: ExtensionContext | ExtensionCommandContext, active: boolean) {
		if (!ctx.hasUI) return;
		if (active) {
			const badge = ctx.ui.theme.bg("toolErrorBg", ctx.ui.theme.bold(ctx.ui.theme.fg("warning", " 🔒 READ-ONLY ")));
			ctx.ui.setStatus(STATUS_KEY, badge);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	function setReadOnly(enable: boolean, ctx: ExtensionContext | ExtensionCommandContext) {
		if (isReadOnly === enable) return;
		isReadOnly = enable;
		if (isReadOnly) {
			process.env.PI_READ_ONLY = "1";
			applyReadOnlyTools();
			updateStatus(ctx, true);
			if (ctx.hasUI) {
				ctx.ui.notify("Read-only mode ENABLED. File edits and shell execution blocked.", "warning");
			}
		} else {
			delete process.env.PI_READ_ONLY;
			restoreTools();
			updateStatus(ctx, false);
			if (ctx.hasUI) {
				ctx.ui.notify("Read-only mode DISABLED. All tools restored.", "info");
			}
		}
	}

	pi.registerFlag("read-only", {
		description: "Start the session in read-only mode (blocks file modifications, enables grep/find/ls/web)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("read-only", {
		description: "Toggle read-only mode (blocks file modifications, enables grep/find/ls/web)",
		handler: async (_args, ctx) => {
			setReadOnly(!isReadOnly, ctx);
		},
	});

	pi.registerCommand("ro", {
		description: "Alias for /read-only",
		handler: async (_args, ctx) => {
			setReadOnly(!isReadOnly, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const flag = pi.getFlag("read-only") ?? pi.getFlag("--read-only");
		if (flag === true || isReadOnly) {
			isReadOnly = false;
			setReadOnly(true, ctx);
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!isReadOnly) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n[READ-ONLY MODE: ACTIVE]\nFile modification and shell execution are strictly disabled. Only read/inspect tools and web search are available. Never attempt to write, edit, or delete files. If changes are needed, describe them or output code blocks for the user to apply manually.`,
		};
	});

	pi.on("tool_call", async (event) => {
		if (!isReadOnly) return;
		if (MUTATING_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Blocked: read-only mode is active. Tool '${event.toolName}' is disabled to prevent file modifications.`,
			};
		}
	});
}