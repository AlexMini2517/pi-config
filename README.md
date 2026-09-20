# pi-config

My personal [pi](https://github.com/earendil-works/pi) configuration and extensions.

This repository is **not** meant to be installed as one monolithic package. Browse the extensions and copy what you need into your own pi agent configuration.

## Extensions

- **[bash-guard](extensions/bash-guard)** — Safety guard intercepting bash tool calls to prevent accidental execution of destructive actions and prompt for confirmation on mutating Git commands. Zero external dependencies, fully compatible with Windows Git Bash and POSIX shells.
- **[clinepass](extensions/clinepass)** — ClinePass subscription provider adapter for pi, giving access to curated open-weight coding models with high rate limits via Cline's API.
- **[md-log](extensions/md-log)** — Real-time chat mirroring to Obsidian-ready Markdown notes with configurable output directory, prompt bloat stripping, and timestamped filenames.
- **[read-only](extensions/read-only)** — Enforces read-only mode by stripping file-mutating tools (`edit`, `write`, `bash`, `powershell`) from active LLM tools while keeping read tools and web search active.


## Installation

### Copy an extension

To install an individual extension into your pi configuration:

```bash
cp -r extensions/<extension-name> ~/.pi/agent/extensions/
```

If the extension contains a `package.json` with external dependencies, install them:

```bash
cd ~/.pi/agent/extensions/<extension-name>
npm install
```

Then restart pi or run `/reload` in your active session.