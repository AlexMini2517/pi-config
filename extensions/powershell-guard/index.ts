import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import type { SelectItem } from "@mariozechner/pi-tui";
import { Container, SelectList, Text } from "@mariozechner/pi-tui";

type Severity = "high" | "medium";

type Risk = {
	severity: Severity;
	reasons: string[];
};

// ─── Windows-aware command analysis ───────────────────────────────────────────
//
// On Windows the agent runs commands via cmd.exe or PowerShell. Both syntaxes
// must be covered. The analysis is regex-based (no shell-quote equivalent exists
// for cmd/PowerShell), operating on the raw command string.
//
// Detection is intentionally broad: we want false-positive prompts rather than
// missed destructive operations.

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Case-insensitive word-boundary test */
function matchesWord(command: string, word: string): boolean {
	return new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(command);
}

function matchesAny(command: string, words: string[]): boolean {
	return words.some((w) => matchesWord(command, w));
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Segment analysis ─────────────────────────────────────────────────────────

function analyzeWindowsCommand(command: string): Risk | null {
	const reasons: string[] = [];
	let severity: Severity = "medium";

	const cmd = command.trim();
	if (!cmd) return null;

	// ── Pipe to shell (remote code execution) ────────────────────────────
	// PowerShell: Invoke-WebRequest ... | Invoke-Expression / iex
	// cmd: curl ... | cmd / powershell
	if (/\b(Invoke-WebRequest|iwr|curl|wget|Invoke-RestMethod|irm)\b/i.test(cmd) &&
		/\|\s*(Invoke-Expression|iex|cmd|powershell|pwsh|sh|bash|zsh|fish)\b/i.test(cmd)) {
		reasons.push("download piped to shell (possible remote code execution)");
		severity = "high";
	}
	// Also: IEX (Invoke-WebRequest ...).Content
	if (/\b(iex|Invoke-Expression)\b/i.test(cmd) &&
		/\b(Invoke-WebRequest|iwr|Net\.WebClient|DownloadString|DownloadFile)\b/i.test(cmd)) {
		reasons.push("remote code download + execution (IEX pattern)");
		severity = "high";
	}

	// ── Privilege escalation ─────────────────────────────────────────────
	if (matchesWord(cmd, "runas")) {
		reasons.push("runas (elevated privileges)");
		severity = "high";
	}
	if (matchesWord(cmd, "gsudo")) {
		reasons.push("gsudo (elevated privileges)");
		severity = "high";
	}
	// Start-Process -Verb RunAs
	if (/\bStart-Process\b/i.test(cmd) && /\b-Verb\s+RunAs\b/i.test(cmd)) {
		reasons.push("Start-Process -Verb RunAs (elevated privileges)");
		severity = "high";
	}

	// ── File / folder deletion ───────────────────────────────────────────
	// PowerShell: Remove-Item, ri, del (alias), rd (alias), rmdir (alias)
	if (/\b(Remove-Item|ri)\b/i.test(cmd)) {
		reasons.push("Remove-Item (file/folder deletion)");
		severity = "high";
		if (/-Recurse\b/i.test(cmd)) reasons.push("-Recurse (recursive deletion)");
		if (/-Force\b/i.test(cmd)) reasons.push("-Force (forced deletion)");
	}
	// cmd.exe: del, erase, rd, rmdir
	if (/^\s*(del|erase)\b/i.test(cmd) || /[;&|]\s*(del|erase)\b/i.test(cmd)) {
		reasons.push("del/erase (file deletion)");
		severity = "high";
		if (/\/[sS]\b/.test(cmd)) reasons.push("/S (recursive deletion)");
		if (/\/[qQ]\b/.test(cmd)) reasons.push("/Q (quiet mode, no confirmation)");
	}
	if (/^\s*(rd|rmdir)\b/i.test(cmd) || /[;&|]\s*(rd|rmdir)\b/i.test(cmd)) {
		reasons.push("rd/rmdir (directory removal)");
		severity = "high";
		if (/\/[sS]\b/.test(cmd)) reasons.push("/S (recursive deletion)");
		if (/\/[qQ]\b/.test(cmd)) reasons.push("/Q (quiet mode, no confirmation)");
	}

	// Git Bash (the shell pi actually uses here): rm, sudo rm, xargs rm
	// ponytail: matchesWord("rm") also matches odd paths like C:\rm\ — false prompt, acceptable
	if (matchesWord(cmd, "rm")) {
		reasons.push("rm (file deletion)");
		severity = "high";
		if (/-[a-zA-Z]*r/i.test(cmd)) reasons.push("-r (recursive deletion)");
		if (/-[a-zA-Z]*f/i.test(cmd)) reasons.push("-f (forced deletion)");
	}

	// ── Clear-Content / Set-Content (truncate/overwrite) ─────────────────
	if (/\bClear-Content\b/i.test(cmd)) {
		reasons.push("Clear-Content (file content erasure)");
		severity = severity === "high" ? "high" : "medium";
	}

	// ── Disk / volume management ─────────────────────────────────────────
	if (matchesWord(cmd, "diskpart")) {
		reasons.push("diskpart (disk partition management)");
		severity = "high";
	}
	// format command
	if (/^\s*format\b/i.test(cmd) || /[;&|]\s*format\b/i.test(cmd)) {
		reasons.push("format (disk formatting)");
		severity = "high";
	}
	// Initialize-Disk, Clear-Disk, Remove-Partition, New-Partition
	if (/\b(Initialize-Disk|Clear-Disk)\b/i.test(cmd)) {
		reasons.push("Initialize-Disk/Clear-Disk (destructive disk operation)");
		severity = "high";
	}
	if (/\bRemove-Partition\b/i.test(cmd)) {
		reasons.push("Remove-Partition (partition deletion)");
		severity = "high";
	}

	// ── Registry editing ─────────────────────────────────────────────────
	if (/\b(reg\s+(delete|add|import))\b/i.test(cmd)) {
		reasons.push("reg delete/add/import (registry modification)");
		severity = "high";
	}
	if (/\b(Remove-ItemProperty|Set-ItemProperty|New-ItemProperty)\b/i.test(cmd) &&
		/\b(HKLM|HKCU|HKCR|HKU|HKCC|Registry)\b/i.test(cmd)) {
		reasons.push("Registry modification via PowerShell cmdlet");
		severity = "high";
	}

	// ── Service management ───────────────────────────────────────────────
	if (/\b(Stop-Service|Set-Service)\b/i.test(cmd)) {
		reasons.push("Stop-Service/Set-Service (service management)");
		severity = severity === "high" ? "high" : "medium";
	}
	if (/\b(sc\s+(stop|delete|config))\b/i.test(cmd)) {
		reasons.push("sc stop/delete/config (service management)");
		severity = severity === "high" ? "high" : "medium";
	}
	// net stop
	if (/\bnet\s+stop\b/i.test(cmd)) {
		reasons.push("net stop (service stop)");
		severity = severity === "high" ? "high" : "medium";
	}

	// ── Process termination ──────────────────────────────────────────────
	if (/\b(Stop-Process|kill)\b/i.test(cmd)) {
		reasons.push("Stop-Process/kill (process termination)");
		severity = severity === "high" ? "high" : "medium";
		if (/-Force\b/i.test(cmd)) {
			reasons.push("-Force (forced termination)");
			severity = "high";
		}
	}
	if (/\btaskkill\b/i.test(cmd)) {
		reasons.push("taskkill (process termination)");
		severity = severity === "high" ? "high" : "medium";
		if (/\/[fF]\b/.test(cmd)) {
			reasons.push("/F (forced termination)");
			severity = "high";
		}
	}

	// ── System power operations ──────────────────────────────────────────
	if (/\b(Stop-Computer|Restart-Computer)\b/i.test(cmd)) {
		reasons.push("Stop-Computer/Restart-Computer (system power operation)");
		severity = "high";
	}
	if (/\bshutdown\b/i.test(cmd) && (/\/[sStrR]\b/.test(cmd) || /\s-[sStrR]\b/.test(cmd))) {
		reasons.push("shutdown (system power operation)");
		severity = "high";
	}

	// ── Move / Copy with overwrite ───────────────────────────────────────
	if (/\bMove-Item\b/i.test(cmd) && /-Force\b/i.test(cmd)) {
		reasons.push("Move-Item -Force (can overwrite files)");
		severity = severity === "high" ? "high" : "medium";
	}
	if (/\bCopy-Item\b/i.test(cmd) && /-Force\b/i.test(cmd)) {
		reasons.push("Copy-Item -Force (can overwrite files)");
		severity = severity === "high" ? "high" : "medium";
	}
	// cmd.exe: move /Y, copy /Y, xcopy /Y, robocopy
	if (/\b(move|copy|xcopy)\b/i.test(cmd) && /\/[yY]\b/.test(cmd)) {
		reasons.push("move/copy/xcopy /Y (overwrite without prompting)");
		severity = severity === "high" ? "high" : "medium";
	}

	// ── Permission / ACL changes ─────────────────────────────────────────
	if (/\bicacls\b/i.test(cmd) && (/\/grant\b/i.test(cmd) || /\/deny\b/i.test(cmd) || /\/remove\b/i.test(cmd) || /\/reset\b/i.test(cmd))) {
		reasons.push("icacls (permission changes)");
		severity = severity === "high" ? "high" : "medium";
	}
	if (/\btakeown\b/i.test(cmd)) {
		reasons.push("takeown (ownership change)");
		severity = severity === "high" ? "high" : "medium";
	}
	if (/\bSet-Acl\b/i.test(cmd)) {
		reasons.push("Set-Acl (permission changes)");
		severity = severity === "high" ? "high" : "medium";
	}

	// ── PowerShell execution policy bypass ────────────────────────────────
	if (/\bSet-ExecutionPolicy\b/i.test(cmd)) {
		reasons.push("Set-ExecutionPolicy (execution policy change)");
		severity = "high";
	}
	if (/-ExecutionPolicy\s+Bypass\b/i.test(cmd)) {
		reasons.push("-ExecutionPolicy Bypass (security bypass)");
		severity = "high";
	}

	// ── Firewall / Windows Defender ──────────────────────────────────────
	if (/\b(netsh\s+advfirewall\s+firewall)\b/i.test(cmd) && /\b(delete|set)\b/i.test(cmd)) {
		reasons.push("netsh firewall rule modification");
		severity = "high";
	}
	if (/\bSet-MpPreference\b/i.test(cmd) && /DisableRealtimeMonitoring/i.test(cmd)) {
		reasons.push("Disabling Windows Defender real-time monitoring");
		severity = "high";
	}

	// ── Environment / system variables ───────────────────────────────────
	if (/\bsetx\b/i.test(cmd)) {
		reasons.push("setx (persistent environment variable change)");
		severity = severity === "high" ? "high" : "medium";
	}

	// ── BCDEdit (boot configuration) ─────────────────────────────────────
	if (/\bbcdedit\b/i.test(cmd)) {
		reasons.push("bcdedit (boot configuration modification)");
		severity = "high";
	}

	// ── sfc / DISM (system file repair, can alter OS) ────────────────────
	if (/\bsfc\b/i.test(cmd) && /\/scannow\b/i.test(cmd)) {
		reasons.push("sfc /scannow (system file checker)");
		severity = severity === "high" ? "high" : "medium";
	}
	if (/\bDISM\b/i.test(cmd)) {
		reasons.push("DISM (system image management)");
		severity = severity === "high" ? "high" : "medium";
	}

	// ── Shell output redirection ─────────────────────────────────────────
	// Redirect false positives excluded: `2>&1` (fd dup), `=>` (arrow). Misses rare bash `&>file`.
	// ponytail: `&>` undetected — add if it ever shows up
	if (/[^-=]>(?!>|&)\s*[^$\s]/i.test(cmd) || />>\s*[^$\s]/i.test(cmd)) {
		reasons.push("output redirection (can overwrite files)");
		severity = severity === "high" ? "high" : "medium";
	}
	// PowerShell: Out-File, Set-Content
	if (/\b(Out-File|Set-Content)\b/i.test(cmd)) {
		reasons.push("Out-File/Set-Content (file write)");
		severity = severity === "high" ? "high" : "medium";
	}

	// ── Pipes ────────────────────────────────────────────────────────────
	if (/\|/.test(cmd) && reasons.length > 0) {
		// Only note pipes if there's already something risky
		reasons.push("pipe operator (chained commands)");
	}

	// ── Git operations (prompt on ANY git command, same as original) ──────
	if (/^\s*git\b/i.test(cmd) || /[;&|]\s*git\b/i.test(cmd)) {
		const gitMatch = cmd.match(/\bgit\s+(\S+)/i);
		const sub = gitMatch ? gitMatch[1] : null;
		const gitReadOnly = !!sub && /^(status|log|diff|show|blame|rev-parse|describe|ls-files|ls-remote|shortlog|help|version)$/i.test(sub);

		if (!gitReadOnly) reasons.push(sub ? `git ${sub} (git command)` : "git (git command)");

		if (sub && /^rm$/i.test(sub)) {
			severity = "high";
			reasons.push("git rm (deletes files from working tree and stages deletions)");
		}
		if (sub && /^clean$/i.test(sub) && /-[a-zA-Z]*f/i.test(cmd)) {
			severity = "high";
			reasons.push("git clean (can delete untracked files)");
		}
		if (sub && /^reset$/i.test(sub) && /--hard\b/i.test(cmd)) {
			severity = "high";
			reasons.push("git reset --hard (discard changes)");
		}
		if (sub && /^(checkout|restore)$/i.test(sub) &&
			(/\s\.\s*$/.test(cmd) || /--source\b/i.test(cmd) || /\s--\s/.test(cmd))) {
			reasons.push("git checkout/restore (can overwrite working tree)");
		}
		if (sub && /^push$/i.test(sub) &&
			(/(--force|--force-with-lease|-f)\b/i.test(cmd))) {
			severity = "high";
			reasons.push("git push --force (rewrite remote history)");
		}
		if (sub && /^reflog$/i.test(sub) && /expire\b/i.test(cmd)) {
			severity = "high";
			reasons.push("git reflog expire (can remove recovery history)");
		}
		if (sub && /^gc$/i.test(sub) && /--prune\b/i.test(cmd)) {
			severity = "high";
			reasons.push("git gc --prune (can permanently delete objects)");
		}
	}

	// ── Infrastructure teardown ──────────────────────────────────────────
	if (/\bkubectl\s+delete\b/i.test(cmd)) {
		severity = "high";
		reasons.push("kubectl delete (resource deletion)");
	}
	if (/\bterraform\s+destroy\b/i.test(cmd)) {
		severity = "high";
		reasons.push("terraform destroy (infrastructure teardown)");
	}
	if (/\baws\s+s3\s+rm\b/i.test(cmd) && /--recursive\b/i.test(cmd)) {
		severity = "high";
		reasons.push("aws s3 rm --recursive (bulk deletion)");
	}
	if (/\bgcloud\b/i.test(cmd) && /\bdelete\b/i.test(cmd)) {
		severity = "high";
		reasons.push("gcloud delete (resource deletion)");
	}
	if (/\baz\b/i.test(cmd) && /\bdelete\b/i.test(cmd)) {
		severity = "high";
		reasons.push("az delete (Azure resource deletion)");
	}

	// ── De-duplicate and return ──────────────────────────────────────────
	const uniq = [...new Set(reasons)];
	if (uniq.length === 0) return null;
	return { severity, reasons: uniq };
}

// ─── Interactive prompt ───────────────────────────────────────────────────────

async function promptRunOrAbort(ctx: any, command: string, risk: Risk): Promise<"run" | "abort"> {
	if (!ctx.hasUI) return "abort";

	const reasonsText = risk.reasons.map((r) => `• ${r}`).join("\n");
	const header = `Command flagged as ${risk.severity.toUpperCase()} risk:`;
	const body = `${header}\n\n${reasonsText}\n\nCommand:\n${command}`;

	const items: SelectItem[] = [
		{ value: "run", label: "Run", description: "Execute the command" },
		{ value: "abort", label: "Abort", description: "Block this command" },
	];

	const choice = await ctx.ui.custom<"run" | "abort">((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
		container.addChild(new Text(theme.fg("warning", theme.bold("Potentially destructive command")), 1, 0));
		container.addChild(new Text(body, 1, 0));

		const list = new SelectList(items, items.length, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});

		list.onSelect = (item) => done(item.value as "run" | "abort");
		list.onCancel = () => done("abort");
		container.addChild(list);

		container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });

	return choice ?? "abort";
}

// ─── Hard-block patterns (disabled-mode floor) ───────────────────────────────
// When powershell-guard is toggled off via /powershell-guard, these catastrophic operations
// remain blocked regardless. Routine git operations (commit/pull/push) are
// allowed through since the user explicitly opted into autonomous mode.
const HARD_BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
	// Recursive deletion — PowerShell
	{ pattern: /\bRemove-Item\b[^#\n]*-Recurse\b/i, reason: "recursive delete (Remove-Item -Recurse)" },
	// Recursive deletion — Git Bash
	{ pattern: /\brm\b[^#\n]*-[a-zA-Z]*r/i, reason: "recursive delete (rm -r)" },
	// Recursive deletion — cmd.exe
	{ pattern: /\b(del|erase)\b[^#\n]*\/[sS]\b/i, reason: "recursive delete (del /S)" },
	{ pattern: /\b(rd|rmdir)\b[^#\n]*\/[sS]\b/i, reason: "recursive delete (rd /S)" },
	// Privilege escalation
	{ pattern: /\brunas\b/i, reason: "elevated privileges (runas)" },
	{ pattern: /\bgsudo\b/i, reason: "elevated privileges (gsudo)" },
	{ pattern: /\bStart-Process\b[^#\n]*-Verb\s+RunAs\b/i, reason: "elevated privileges (Start-Process RunAs)" },
	// Remote code execution via pipe-to-shell
	{ pattern: /\b(Invoke-WebRequest|iwr|curl|wget|irm|Invoke-RestMethod)\b[^#\n]*\|\s*(Invoke-Expression|iex|cmd|powershell|pwsh|sh|bash|zsh|fish)\b/i, reason: "pipe to shell (remote code execution)" },
	{ pattern: /\b(iex|Invoke-Expression)\b[^#\n]*\b(Invoke-WebRequest|iwr|Net\.WebClient|DownloadString)\b/i, reason: "remote code execution (IEX + download)" },
	// Disk / filesystem destruction
	{ pattern: /\bdiskpart\b/i, reason: "disk partition management (diskpart)" },
	{ pattern: /(?:^\s*|[;&|]\s*)format\b/im, reason: "disk formatting (format)" },
	{ pattern: /\b(Initialize-Disk|Clear-Disk)\b/i, reason: "destructive disk operation" },
	{ pattern: /\bRemove-Partition\b/i, reason: "partition deletion" },
	// Boot configuration
	{ pattern: /\bbcdedit\b/i, reason: "boot configuration modification (bcdedit)" },
	// Registry — high-risk mutations
	{ pattern: /\breg\s+delete\b/i, reason: "registry deletion (reg delete)" },
	// System power
	{ pattern: /\b(Stop-Computer|Restart-Computer)\b/i, reason: "system power operation" },
	{ pattern: /\bshutdown\b[^#\n]*\/[sStrR]\b/i, reason: "system power operation (shutdown)" },
	// Security bypass
	{ pattern: /\bSet-ExecutionPolicy\b/i, reason: "execution policy change" },
	{ pattern: /\bSet-MpPreference\b[^#\n]*DisableRealtimeMonitoring/i, reason: "disabling Windows Defender" },
	// Infrastructure teardown
	{ pattern: /\bterraform\s+destroy\b/i, reason: "infrastructure teardown (terraform destroy)" },
	{ pattern: /\bkubectl\s+delete\b/i, reason: "Kubernetes resource deletion" },
	{ pattern: /\baws\s+s3\s+rm\b[^#\n]*--recursive/i, reason: "bulk S3 deletion (aws s3 rm --recursive)" },
	// Destructive git operations
	{ pattern: /\bgit\s+reset\b[^#\n]*--hard\b/i, reason: "discard all uncommitted changes (git reset --hard)" },
	{ pattern: /\bgit\s+clean\b[^#\n]*-[a-zA-Z]*f/i, reason: "delete untracked files (git clean -f)" },
	{ pattern: /\bgit\s+reflog\s+expire\b/i, reason: "expire reflog (removes recovery history)" },
	{ pattern: /\bgit\s+gc\b[^#\n]*--prune\b/i, reason: "prune unreachable objects (git gc --prune)" },
];

// ─── Status bar key ───────────────────────────────────────────────────────────
const PS_GUARD_STATUS_KEY = " powershell-guard";

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Interactive prompting mode.
	pi.registerFlag("powershell-guard-auto-allow", {
		description: "If set, powershell-guard will not block when no UI is available (non-interactive modes).",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("powershell-guard-disabled", {
		description: "Start the session with powershell-guard disabled (autonomous mode; hard-block floor still applies).",
		type: "boolean",
		default: false,
	});

	// Session-local toggle. Intentionally not persisted across reloads or restarts.
	let disabled = false;

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" && pi.getFlag("--powershell-guard-disabled") === true) {
			disabled = true;
			const { theme } = ctx.ui;
			const badge = theme.bg(
				"toolErrorBg",
				theme.bold(theme.fg("error", " ⚠ PG OFF ")),
			);
			ctx.ui.setStatus(PS_GUARD_STATUS_KEY, badge);
		}
	});

	pi.registerCommand("powershell-guard", {
		description: "Toggle powershell-guard between interactive (default) and disabled (autonomous) for this session.",
		handler: async (_args, ctx) => {
			disabled = !disabled;
			if (disabled) {
				const { theme } = ctx.ui;
				const badge = theme.bg(
					"toolErrorBg",
					theme.bold(theme.fg("error", " ⚠ PG OFF ")),
				);
				ctx.ui.setStatus(PS_GUARD_STATUS_KEY, badge);
				ctx.ui.notify(
					"powershell-guard DISABLED for this session. Catastrophic operations are still hard-blocked. Run /powershell-guard again to re-enable.",
					"warning",
				);
			} else {
				ctx.ui.setStatus(PS_GUARD_STATUS_KEY, undefined);
				ctx.ui.notify("powershell-guard re-enabled.", "info");
			}
		},
	});

	// Avoid annoying retry loops: if the exact command was aborted recently, auto-block it.
	const recentlyAborted = new Map<string, number>();
	const ABORT_REMEMBER_MS = 60_000;

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;

		// Disabled (autonomous) mode: skip interactive prompting entirely, but keep
		// a hard-block floor for catastrophic operations.
		if (disabled) {
			for (const { pattern, reason } of HARD_BLOCKED) {
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

		const risk = analyzeWindowsCommand(command);
		if (!risk) return;

		const now = Date.now();
		const lastAbort = recentlyAborted.get(command);
		if (lastAbort && now - lastAbort < ABORT_REMEMBER_MS) {
			return {
				block: true,
				reason:
					"Blocked by powershell-guard: command was already aborted recently. Ask the user for a safer alternative; do not retry the same command.",
			};
		}

		if (!ctx.hasUI && pi.getFlag("--powershell-guard-auto-allow")) {
			// Non-interactive mode: allow when explicitly requested.
			return;
		}

		const choice = await promptRunOrAbort(ctx, command, risk);
		if (choice === "run") return;

		recentlyAborted.set(command, now);
		return {
			block: true,
			reason:
				"Blocked by user via powershell-guard (potentially destructive command). Ask the user for confirmation or propose a non-destructive alternative.",
		};
	});
}