# md-log

Real-time session mirroring to Obsidian-ready Markdown for [pi](https://github.com/earendil-works/pi).

Captures conversations cleanly as you chat, stripping prompt bloat and formatting messages for reading and indexing in your Second Brain or note vault.

## Features

- **Live Streaming**: Writes prompts and assistant responses to a Markdown file in real time as the chat progresses.
- **Zero Skill Bloat**: Automatically strips injected `<skill name="...">...</skill>` tags from prompts so your notes remain clean and readable.
- **Obsidian-Ready**: Generates YAML frontmatter (`title`, `date`, `session_id`, `tags: [ai/pi-agent, second-brain]`) and structured headers (`### 👤 Utente`, `### 🤖 Pi`).
- **Timestamped Filenames**: Sessions are automatically named `YYYY-MM-DD_HH-MM-SS.md` based on the exact moment the first command/prompt is sent.
- **Portable & Configurable**: No hardcoded personal paths. The output directory is saved locally in `~/.pi/agent/md-log.json`.

## Commands

- `/md-dir` — Show the current output directory (or prompts to set it if not yet configured).
- `/md-setdir [path]` — Set or update the output directory. If no path is passed, opens an interactive input prompt.
- `/md-log [path]` — Show mirroring status, link to a specific file, or force immediate file creation.
- `/md-unlog` — Stop mirroring for the current session.

## Installation

Copy the `md-log` folder into your pi extensions directory:

```bash
cp -r extensions/md-log ~/.pi/agent/extensions/
```

Then restart pi or run `/reload`. On your first prompt, pi will prompt for your preferred Markdown vault directory if not already set.
