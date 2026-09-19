# bash-guard

Safety guard extension for [pi](https://github.com/earendil-works/pi).

Intercepts calls to the `bash` tool to prevent accidental execution of destructive or risky commands without disrupting standard development workflows.

Designed to be **zero-dependency**, lightweight, and fully compatible with Git Bash on Windows as well as POSIX shells on Linux/macOS.

## Features

- **Zero External Dependencies**: Standard Node.js only. Works out-of-the-box without `npm install`.
- **Windows & POSIX Safe**: Does not mangle Windows backslashes in paths (`C:\...`).
- **Zero False Positives on Read-Only Operations**:
  - Redirections to `/dev/null`, `nul`, or `$null` (e.g. `2>/dev/null`) are allowed without prompting.
  - Pipes (`|`) are permitted (e.g. `grep ... | head` or `ls | head` pass freely).
  - Read-only Git commands (`git status`, `git log`, `git diff`, `git branch`, etc.) run uninterrupted.

## Modes

Behavior adapts automatically based on the `PI_SUBAGENT_DEPTH` environment variable.

### 1. Interactive Sessions (Root Agent)

Displays an interactive confirmation popup (**Run** / **Abort**) when detecting:

- **File & Directory Deletion**: `rm`, `rmdir`, `unlink`, `find -delete`
- **Privilege Escalation**: `sudo`
- **Remote Code Execution (RCE)**: `curl ... | bash`, `wget ... | sh`
- **Mutating Git Commands**: Prompts for confirmation on any command modifying repo state (`git commit`, `git push`, `git pull`, `git checkout`, `git merge`, `git add`, `git reset`, etc.). Highly destructive commands (`git reset --hard`, `git push --force`, `git clean -f`, `git rm`) are elevated to HIGH severity. Read-only Git commands (`git status`, `git log`, `git diff`, `git show`, `git blame`) execute immediately.
- **In-place Mutation / Truncation**: `truncate`, `dd of=...`, `sed -i`, `perl -pi`, `chmod/chown -R`, `mv/cp --force`
- **Process & System Termination**: `kill -9`, `pkill`, `killall`, `shutdown`, `reboot`, `systemctl stop/disable`
- **Disk & Partition Management**: `mkfs`, `fdisk`, `parted`, `wipefs`, `cryptsetup`, `zpool`, `diskutil`, `hdiutil`
- **Infrastructure Teardown**: `kubectl delete`, `terraform destroy`, `aws s3 rm --recursive`, `gcloud delete`
- **File Overwrites via Redirection**: `>` or `>>` targeting real files

If a command is aborted (**Abort**), it is cached for 60 seconds to prevent the agent from entering a retry loop.

### 2. Subagent Sessions (Headless / Non-interactive)

When `PI_SUBAGENT_DEPTH >= 1` (subagents without an interactive TUI), catastrophic irreversible commands are **blocked automatically at the root**:

- `rm -r` / `-rf`
- `sudo`
- `curl | sh` / `wget | sh`
- Disk formatting and raw writes (`mkfs`, `dd of=/dev/...`, `wipefs`, `diskutil erase`)
- `shutdown`, `reboot`
- `terraform destroy`, `kubectl delete`, `aws s3 rm --recursive`
- `git commit`, `git pull`, `git push`, `git reset --hard`, `git clean -f`

## Commands & Flags

- `/bash-guard` — Toggle interactive confirmation prompts on/off for the current session (catastrophic safety blocks remain active).
- `--bash-guard-disabled` — Start pi with bash-guard disabled for the entire session.
- `--bash-guard-auto-allow` — In headless non-interactive mode, permits flagged commands instead of blocking them.

## Installation

Copy the `bash-guard` folder into your pi extensions directory:

```bash
cp -r extensions/bash-guard ~/.pi/agent/extensions/
```

Then restart pi or run `/reload`.
