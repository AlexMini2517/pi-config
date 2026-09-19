import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";

type Severity = "high" | "medium";

type Risk = {
	severity: Severity;
	reasons: string[];
};

interface PatternRule {
	pattern: RegExp;
	reason: string;
	severity?: Severity;
}

// ─── Interactive Rules (zero external dependencies, Windows/POSIX-safe) ──────
// Avoids AST shell-quote parsing so Windows backslashes in paths don't get warped.
const INTERACTIVE_RULES: PatternRule[] = [
	// Remote code execution
	{
		pattern: /\b(curl|wget)\b[^#\n]*\|\s*(ba?sh|zsh|fish|dash|sh)\b/i,
		reason: "pipe to shell (remote code execution)",
		severity: "high",
	},

	// Privilege escalation
	{
		pattern: /\bsudo\b/i,
		reason: "elevated privileges (sudo)",
		severity: "high",
	},

	// File / directory deletion
	{
		pattern: /(?<!\bgit\s+)\b(rm|rmdir|unlink)\b/i,
		reason: "file/folder deletion",
		severity: "high",
	},
	{
		pattern: /\bfind\b[^#\n]*-delete\b/i,
		reason: "bulk deletion (find -delete)",
		severity: "high",
	},

	// Git operations: ask permission for any state-modifying git command (status, log, diff, show pass freely)
	{
		pattern: /\bgit\s+(?!(?:status|log|diff|show|blame|rev-parse|describe|ls-files|ls-remote|shortlog|help|version)\b)\S+/i,
		reason: "git command (modifies repository)",
		severity: "medium",
	},

	// Destructive git operations (elevate to HIGH severity)
	{
		pattern: /\bgit\s+rm\b/i,
		reason: "git rm (deletes files from working tree and stages deletions)",
		severity: "high",
	},
	{
		pattern: /\bgit\s+reset\b[^#\n]*--hard\b/i,
		reason: "git reset --hard (discard changes)",
		severity: "high",
	},
	{
		pattern: /\bgit\s+clean\b[^#\n]*-[a-zA-Z]*f/i,
		reason: "git clean (can delete untracked files)",
		severity: "high",
	},
	{
		pattern: /\bgit\s+push\b[^#\n]*(--force|--force-with-lease|-f)\b/i,
		reason: "git push --force (rewrite remote history)",
		severity: "high",
	},
	{
		pattern: /\bgit\s+(checkout|restore)\b[^#\n]*(\s\.\s*|--source|--\s)/i,
		reason: "git checkout/restore (can overwrite working tree)",
		severity: "medium",
	},
	{
		pattern: /\bgit\s+reflog\s+expire\b/i,
		reason: "git reflog expire (can remove recovery history)",
		severity: "high",
	},
	{
		pattern: /\bgit\s+gc\b[^#\n]*--prune\b/i,
		reason: "git gc --prune (can permanently delete objects)",
		severity: "high",
	},

	// In-place modifications / truncation / raw writes
	{
		pattern: /\btruncate\b/i,
		reason: "truncate (in-place size change)",
		severity: "medium",
	},
	{
		pattern: /\bdd\b[^#\n]*\bof=/i,
		reason: "dd raw write (can overwrite data)",
		severity: "high",
	},
	{
		pattern: /\bsed\b[^#\n]*(-i|--in-place)\b/i,
		reason: "sed -i (in-place file modification)",
		severity: "medium",
	},
	{
		pattern: /\bperl\b[^#\n]*-p?i\b/i,
		reason: "perl in-place edit",
		severity: "medium",
	},
	{
		pattern: /\b(chmod|chown)\b[^#\n]*(-R|--recursive)\b/i,
		reason: "recursive permission/ownership change",
		severity: "medium",
	},
	{
		pattern: /\b(mv|cp)\b[^#\n]*(-f|--force)\b/i,
		reason: "mv/cp --force (can overwrite files)",
		severity: "medium",
	},

	// Process termination / system power
	{
		pattern: /\bkill\b[^#\n]*-9\b/i,
		reason: "SIGKILL (-9)",
		severity: "high",
	},
	{
		pattern: /\b(pkill|killall)\b/i,
		reason: "process termination",
		severity: "medium",
	},
	{
		pattern: /\b(shutdown|reboot|halt|poweroff)\b/i,
		reason: "system power operation",
		severity: "high",
	},
	{
		pattern: /\bsystemctl\s+(stop|disable)\b/i,
		reason: "systemctl stop/disable (service disruption)",
		severity: "medium",
	},

	// Disk / filesystem management
	{
		pattern: /\b(mkfs|newfs_\w+|wipefs|parted|fdisk|gdisk|sgdisk|cryptsetup|pvcreate|vgcreate|lvcreate|zpool|diskutil|hdiutil)\b/i,
		reason: "disk/filesystem management",
		severity: "high",
	},

	// Infrastructure teardown
	{
		pattern: /\bkubectl\s+delete\b/i,
		reason: "kubectl delete (resource deletion)",
		severity: "high",
	},
	{
		pattern: /\bterraform\s+destroy\b/i,
		reason: "terraform destroy (infrastructure teardown)",
		severity: "high",
	},
	{
		pattern: /\baws\s+s3\s+rm\b[^#\n]*--recursive\b/i,
		reason: "aws s3 rm --recursive (bulk deletion)",
		severity: "high",
	},
	{
		pattern: /\bgcloud\b[^#\n]*\bdelete\b/i,
		reason: "gcloud delete (resource deletion)",
		severity: "high",
	},

	// Output redirection to file: matches > or >> but excludes /dev/null, nul, $null and fd dup (&1, &2)
	{
		pattern: /(?:^|[^|&;\s])\s*(?:[12]?>|>>)\s*(?!\/dev\/null\b|nul\b|\$null\b|&)\S+/i,
		reason: "output redirection (can overwrite files)",
		severity: "medium",
	},
];

function analyzeBashCommand(command: string): Risk | null {
	const reasons: string[] = [];
	let severity: Severity = "medium";

	for (const rule of INTERACTIVE_RULES) {
		if (rule.pattern.test(command)) {
			reasons.push(rule.reason);
			if (rule.severity === "high") {
				severity = "high";
			}
		}
	}

	const uniq = [...new Set(reasons)];
	if (uniq.length === 0) return null;
	return { severity, reasons: uniq };
}

async function promptRunOrAbort(ctx: any, command: string, risk: Risk): Promise<"run" | "abort"> {
	if (!ctx.hasUI) return "abort";

	const reasonsText = risk.reasons.map((r) => `• ${r}`).join("\n");
	const header = `Command flagged as ${risk.severity.toUpperCase()} risk:`;
	const body = `${header}\n\n${reasonsText}\n\nCommand:\n${command}`;

	const items: SelectItem[] = [
		{ value: "run", label: "Run", description: "Execute the command" },
		{ value: "abort", label: "Abort", description: "Block this command" },
	];

	const choice = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (val: "run" | "abort") => void) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
		container.addChild(new Text(theme.fg("warning", theme.bold("Potentially destructive bash command")), 1, 0));
		container.addChild(new Text(body, 1, 0));

		const list = new SelectList(items, items.length, {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});

		list.onSelect = (item: any) => done(item.value as "run" | "abort");
		list.onCancel = () => done("abort");
		container.addChild(list);

		container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));

		return {
			render: (w: any) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: any) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });

	return (choice as "run" | "abort") ?? "abort";
}

// PI_SUBAGENT_DEPTH is 0 (or unset) in the main session and >= 1 in spawned subagent processes.
const _subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
const _isSubagent = Number.isFinite(_subagentDepth) && _subagentDepth >= 1;

// Hard-block patterns for subagent (headless) mode.
const HEADLESS_BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /(?<!\bgit\s+)\brm\b[^#\n]*\s-(?:[a-zA-Z]*[rR]|-\brecursive\b)/i, reason: "recursive delete (rm -r / -rf)" },
	{ pattern: /\bsudo\b/i, reason: "elevated privileges (sudo)" },
	{ pattern: /\b(curl|wget)\b[^#\n]*\|\s*(ba?sh|zsh|fish|dash|sh)\b/i, reason: "pipe to shell (remote code execution)" },
	{ pattern: /\b(mkfs|newfs_\w+|wipefs|cryptsetup|zpool|diskutil\s+(erase|zeroDisk|secureErase|reformat))\b/i, reason: "disk/filesystem destruction" },
	{ pattern: /\bdd\b[^#\n]*\bof=\/dev\//i, reason: "raw disk write (dd of=/dev/...)" },
	{ pattern: /\b(parted|fdisk|gdisk|sgdisk)\b/i, reason: "partition table management" },
	{ pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "system power operation" },
	{ pattern: /\b(terraform\s+destroy|kubectl\s+delete|aws\s+s3\s+rm\b[^#\n]*--recursive)\b/i, reason: "infrastructure teardown" },
	{ pattern: /\bgit\s+reset\b[^#\n]*--hard\b/i, reason: "discard all uncommitted changes (git reset --hard)" },
	{ pattern: /\bgit\s+clean\b[^#\n]*-[a-zA-Z]*f/i, reason: "delete untracked files (git clean -f)" },
	{ pattern: /\bgit\s+reflog\s+expire\b/i, reason: "expire reflog (removes recovery history)" },
	{ pattern: /\bgit\s+gc\b[^#\n]*--prune\b/i, reason: "prune unreachable objects (git gc --prune)" },
];

const MAIN_DISABLED_BLOCKED: Array<{ pattern: RegExp; reason: string }> = HEADLESS_BLOCKED;

const BASH_GUARD_STATUS_KEY = " bash-guard";

export default function (pi: ExtensionAPI) {
	if (_isSubagent) {
		pi.on("tool_call", async (event) => {
			if (!isToolCallEventType("bash", event)) return;
			const command = event.input.command;
			for (const { pattern, reason } of HEADLESS_BLOCKED) {
				if (pattern.test(command)) {
					return {
						block: true,
						reason:
							`Blocked by bash-guard: ${reason}. ` +
							"This is a non-interactive subagent session — catastrophic operations are not permitted. " +
							"Propose a safer alternative or ask the parent agent to confirm with the user.",
					};
				}
			}
		});
		return;
	}

	pi.registerFlag("bash-guard-auto-allow", {
		description: "If set, bash-guard will not block when no UI is available (non-interactive modes).",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("bash-guard-disabled", {
		description: "Start the session with bash-guard disabled (autonomous mode; hard-block floor still applies).",
		type: "boolean",
		default: false,
	});

	let disabled = false;

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" && pi.getFlag("--bash-guard-disabled") === true) {
			disabled = true;
			const { theme } = ctx.ui;
			const badge = theme.bg(
				"toolErrorBg",
				theme.bold(theme.fg("error", " ⚠ BG OFF ")),
			);
			ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, badge);
		}
	});

	pi.registerCommand("bash-guard", {
		description: "Toggle bash-guard between interactive (default) and disabled (autonomous) for this session.",
		handler: async (_args, ctx) => {
			disabled = !disabled;
			if (disabled) {
				const { theme } = ctx.ui;
				const badge = theme.bg(
					"toolErrorBg",
					theme.bold(theme.fg("error", " ⚠ BG OFF ")),
				);
				ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, badge);
				ctx.ui.notify(
					"bash-guard DISABLED for this session. Catastrophic operations are still hard-blocked. Run /bash-guard again to re-enable.",
					"warning",
				);
			} else {
				ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, undefined);
				ctx.ui.notify("bash-guard re-enabled.", "info");
			}
		},
	});

	const recentlyAborted = new Map<string, number>();
	const ABORT_REMEMBER_MS = 60_000;

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;

		if (disabled) {
			for (const { pattern, reason } of MAIN_DISABLED_BLOCKED) {
				if (pattern.test(command)) {
					return {
						block: true,
						reason:
							`Blocked by bash-guard (disabled-mode floor): ${reason}. ` +
							"Even with bash-guard disabled, this pattern is considered too destructive to run unattended. " +
							"Re-enable bash-guard with /bash-guard and confirm interactively, or propose a safer alternative.",
					};
				}
			}
			return;
		}

		const risk = analyzeBashCommand(command);
		if (!risk) return;

		const now = Date.now();
		const lastAbort = recentlyAborted.get(command);
		if (lastAbort && now - lastAbort < ABORT_REMEMBER_MS) {
			return {
				block: true,
				reason:
					"Blocked by bash-guard: command was already aborted recently. Ask the user for a safer alternative; do not retry the same command.",
			};
		}

		if (!ctx.hasUI && pi.getFlag("--bash-guard-auto-allow")) {
			return;
		}

		const choice = await promptRunOrAbort(ctx, command, risk);
		if (choice === "run") return;

		recentlyAborted.set(command, now);
		return {
			block: true,
			reason:
				"Blocked by user via bash-guard (potentially destructive command). Ask the user for confirmation or propose a non-destructive alternative.",
		};
	});
}
