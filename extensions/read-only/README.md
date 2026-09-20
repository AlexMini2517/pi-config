# read-only

Enforces read-only mode in Pi:
- Strips file-mutating tools (`edit`, `write`, `bash`, `powershell`) from active LLM tools so the model cannot attempt writes
- Automatically enables read-only discovery tools (`read`, `grep`, `find`, `ls`)
- Keeps custom extension tools (such as web search / fetch) available
- Hard-blocks any mutating tool calls in `tool_call` as a fail-safe

## Usage

- **Command**: `/read-only` or `/ro` in any session to toggle.
- **CLI Flag**: `pi --read-only` to launch directly in read-only mode.
- **TUI Indicator**: Displays `🔒 READ-ONLY` badge in the footer when active.