/**
 * md-log — Auto-mirror Pi Agent sessions to Markdown (Obsidian-ready).
 *
 * Automatically mirrors the current chat to:
 * <output_dir>/YYYY-MM-DD_HH-MM-SS.md
 *
 * Strips skill injections, formats for Obsidian, and streams in real time.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "md-log.json");

function getSavedDir(): string | null {
	try {
		if (fs.existsSync(CONFIG_FILE)) {
			const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
			return typeof data.outputDir === "string" && data.outputDir.trim().length > 0
				? data.outputDir.trim()
				: null;
		}
	} catch { }
	return null;
}

function saveOutputDir(dir: string): void {
	fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify({ outputDir: dir }, null, 2), "utf-8");
}

function formatTimestamp(d = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function stripSkillBlocks(text: string): string {
	return text.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/g, "").trim();
}

export default function mdLog(pi: ExtensionAPI) {
	let logFile: string | null = null;
	let sessionTitle = "Sessione Pi Agent";
	let writeLock: Promise<void> = Promise.resolve();

	let assistantHeaderWritten = false;

	function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		const prev = writeLock;
		let release: () => void;
		writeLock = new Promise<void>((r) => {
			release = r;
		});
		return prev.then(fn).finally(() => release!());
	}

	function appendToFile(text: string): void {
		if (!logFile) return;
		try {
			let current = "";
			if (fs.existsSync(logFile)) {
				current = fs.readFileSync(logFile, "utf-8");
			}
			const prefix = current.trim().length > 0 ? "\n\n" : "";
			fs.writeFileSync(logFile, current.trimEnd() + prefix + text + "\n", "utf-8");
		} catch { }
	}

	function getBackfillHistory(ctx: any): string[] {
		const blocks: string[] = [];
		if (!ctx?.sessionManager?.getEntries) return blocks;
		let currentAssistantParts: string[] = [];

		const flushAssistant = () => {
			if (currentAssistantParts.length > 0) {
				blocks.push(`---\n\n# ASSISTANT\n\n${currentAssistantParts.join("\n\n")}`);
				currentAssistantParts = [];
			}
		};

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "message" || !entry.message) continue;
			const msg = entry.message;
			if (msg.role === "user") {
				flushAssistant();
				const raw = typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
						: "";
				const text = stripSkillBlocks(raw.trim());
				if (text) blocks.push(`---\n\n# USER\n\n${text}`);
			} else if (msg.role === "assistant") {
				const parts = (msg.content || [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => (c.text as string).trim())
					.filter(Boolean);
				if (parts.length > 0) currentAssistantParts.push(parts.join("\n\n"));
			}
		}
		flushAssistant();
		return blocks;
	}

	async function ensureOutputDir(ctx: any): Promise<string | null> {
		let dir = getSavedDir();
		if (dir) return dir;

		if (ctx?.ui?.input) {
			const entered = await ctx.ui.input("Cartella output per note Markdown (es. D:/Notes):");
			if (entered && entered.trim().length > 0) {
				dir = path.resolve(ctx.cwd || process.cwd(), entered.trim());
				saveOutputDir(dir);
				ctx.ui.notify?.(`Cartella configurata: ${dir}`, "success");
				return dir;
			}
		}
		ctx?.ui?.notify?.("Mirroring disattivato: usa /md-setdir <percorso> per configurare la cartella.", "warning");
		return null;
	}

	function initLogFile(firstPromptText: string, sessionId: string, outDir: string, ctx: any): void {
		if (logFile) return;
		fs.mkdirSync(outDir, { recursive: true });

		const filename = `${formatTimestamp()}.md`;
		logFile = path.join(outDir, filename);

		const firstLine = firstPromptText.split("\n")[0].trim().replace(/^[\/#@]\S+\s*/g, "");
		sessionTitle = (firstLine.length > 3 ? firstLine.slice(0, 65) : "Sessione Pi Agent").replace(/"/g, '\\"');

		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const dateDisplay = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

		const frontmatter = [
			"---",
			`title: "${sessionTitle}"`,
			`date: ${dateDisplay}`,
			`session_id: "${sessionId}"`,
			"tags:",
			"  - ai/pi-agent",
			"  - second-brain",
			"---",
			"",
			`# ${sessionTitle}`,
			"",
		].join("\n");

		fs.writeFileSync(logFile, frontmatter + "\n", "utf-8");
		pi.appendEntry("md-log", { file: logFile });

		if (ctx?.ui?.theme) {
			ctx.ui.setStatus("md-log", ctx.ui.theme.fg("accent", "🗒 ") + ctx.ui.theme.fg("dim", filename));
		}
	}

	pi.on("session_start", async (_event, ctx: any) => {
		assistantHeaderWritten = false;
		let lastData: { file: string | null } | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "md-log") {
				lastData = entry.data as { file: string | null } | undefined;
			}
		}
		if (lastData?.file && fs.existsSync(lastData.file)) {
			logFile = lastData.file;
			if (ctx.ui?.theme) {
				ctx.ui.setStatus("md-log", ctx.ui.theme.fg("accent", "🗒 ") + ctx.ui.theme.fg("dim", path.basename(logFile)));
			}
		}
	});

	pi.on("message_end", async (event, ctx: any) => {
		const msg = event.message;
		if (!msg || !("role" in msg)) return;

		if (msg.role === "user") {
			const rawText = typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
					: "";
			const text = stripSkillBlocks(rawText.trim());
			if (!text) return;

			if (!logFile) {
				const dir = getSavedDir();
				if (dir) {
					const sid = ctx?.sessionManager?.getSessionId?.() || "session";
					initLogFile(text, sid, dir, ctx);
				}
			}
			if (!logFile) return;

			assistantHeaderWritten = false;
			await withLock(() => {
				appendToFile(`---\n\n# USER\n\n${text}`);
			});
			return;
		}

		if (msg.role === "assistant") {
			if (!logFile) return;
			const textParts = (msg.content || [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => (c.text as string).trim())
				.filter((t: string) => t.length > 0);
			if (textParts.length === 0) return;

			await withLock(() => {
				const body = textParts.join("\n\n");
				if (!assistantHeaderWritten) {
					appendToFile(`---\n\n# ASSISTANT\n\n${body}`);
					assistantHeaderWritten = true;
				} else {
					appendToFile(body);
				}
			});
			return;
		}
	});

	pi.registerCommand("md-dir", {
		description: "Mostra la cartella di output corrente per le note Markdown",
		handler: async (_args, ctx: any) => {
			const dir = getSavedDir();
			if (dir) {
				ctx.ui.notify(`Cartella output: ${dir}`, "info");
			} else {
				await ensureOutputDir(ctx);
			}
		},
	});

	pi.registerCommand("md-setdir", {
		description: "Imposta o modifica la cartella di output per le note Markdown",
		handler: async (args, ctx: any) => {
			let target = args.trim();
			if (!target && ctx?.ui?.input) {
				const current = getSavedDir() || "";
				target = (await ctx.ui.input("Nuova cartella di output per le note Markdown:", current)) || "";
			}
			if (!target) {
				ctx.ui.notify("Nessuna cartella impostata.", "warning");
				return;
			}
			const resolved = path.resolve(ctx.cwd || process.cwd(), target);
			saveOutputDir(resolved);
			ctx.ui.notify(`Cartella output aggiornata: ${resolved}`, "success");
		},
	});

	pi.registerCommand("md-log", {
		description: "Status del mirroring o forza creazione/collegamento file",
		handler: async (args, ctx: any) => {
			const target = args.trim();
			if (target) {
				logFile = path.isAbsolute(target) ? target : path.resolve(ctx.cwd, target);
				pi.appendEntry("md-log", { file: logFile });
				ctx.ui.setStatus("md-log", ctx.ui.theme.fg("accent", "🗒 ") + ctx.ui.theme.fg("dim", path.basename(logFile)));
				ctx.ui.notify(`Collegato a: ${logFile}`, "success");
			} else if (logFile) {
				ctx.ui.notify(`Mirroring attivo su: ${logFile}`, "info");
			} else {
				const outDir = await ensureOutputDir(ctx);
				if (!outDir) return;
				const sid = ctx.sessionManager?.getSessionId?.() || "session";
				initLogFile("Sessione Pi Agent", sid, outDir, ctx);
				const history = getBackfillHistory(ctx);
				if (history.length > 0) {
					appendToFile(history.join("\n\n"));
				}
				ctx.ui.notify(`Creato e collegato: ${logFile}`, "success");
			}
		},
	});

	pi.registerCommand("md-unlog", {
		description: "Interrompe il mirroring su Markdown per questa sessione",
		handler: async (_args, ctx: any) => {
			if (!logFile) {
				ctx.ui.notify("Nessun file collegato.", "warning");
				return;
			}
			const name = path.basename(logFile);
			logFile = null;
			pi.appendEntry("md-log", { file: null });
			ctx.ui.setStatus("md-log", undefined);
			ctx.ui.notify(`Scollegato: ${name}`, "info");
		},
	});
}