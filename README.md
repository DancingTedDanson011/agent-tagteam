<div align="center">

# CLI Organizer

### Claude Code × Codex × OpenCode as a tag team

**All your terminals in one window. Your AI coding agents side by side, and one of them can start, brief and check the others.**

<!-- VIDEO: drag the promo video into this spot while editing this file on github.com, then delete this line -->

[Download for Windows](../../releases/latest) · [Deutsch](README.de.md) · [License](#license)

</div>



https://github.com/user-attachments/assets/f376ff46-90ed-44b8-8516-364641b3e4e3




---

## Project Cockpit preview

[Download the Windows preview](../../releases/download/v0.6.1/CLI-Organizer-0.6.1-portable.exe) · [Cockpit usage guide (German)](docs/cockpit-usage.md)

Track projects, agent sessions, waiting items, tasks and contracts in the new Cockpit view. Projects, tasks and check evidence are stored locally and loaded when the app reopens. Run approved contract checks and record explicit manual acceptance; changed source invalidates old evidence. The observing Claude plugin is optional. Live question and permission hook interactions still need manual validation.

## The problem

You run Claude Code in one terminal, Codex in another, a dev server in a third, a build in a fourth.
Ten minutes later you have a wall of windows, and you keep missing the moment an agent finished or
started waiting for your answer. Worse: your agents live in separate worlds. Claude Code cannot hand
a task to Codex, cannot read what Codex wrote, cannot check its work.

## What CLI Organizer does

**One window for every terminal.** Drag your running cmd, PowerShell or Windows Terminal windows in.
They keep running exactly as before, now arranged in Focus, Grid, Free or Tabs view, with a dock
for the ones you park. Close the app and every window gets its original size, position and frame
back, even after a crash.

**It tells you when an agent needs you.** A badge appears the moment an agent is done or waiting.
No more checking ten windows.

**Agents that work as a team.** Start Claude Code, Codex or OpenCode as a tile inside the app. Every
AI tile gets the organizer's tools, so one agent can open another one as a visible tile next to it,
give it a task, wait for it, read the result and check it before building on it:

> "Open Codex in this folder, let it write the tests for the parser, then review them."

Claude Code briefs Codex. Codex asks OpenCode for a second opinion. You watch all of it live, in
tiles you can read and type into at any moment. Nothing runs hidden in a background shell.

## Features

| | |
|---|---|
| **Capture any terminal** | cmd, PowerShell, Windows Terminal: drag it in or pick it from a list |
| **Four views** | Focus, Grid, Free and Tabs, switch with `Ctrl+1` to `Ctrl+4` |
| **"Waiting for you" badge** | exact for Claude Code, screen based for everything else |
| **Agent tiles** | Claude Code, Codex, OpenCode, cmd and PowerShell run inside the app |
| **Orchestration** | any AI tile can start and drive other agents as tiles (MCP tools) |
| **Workspaces** | save a layout; applying it reopens missing terminals in their folders, with their names and colours |
| **Voice input** | hold `-` or click *Speak*: your words are typed into the active terminal, recognized locally with Whisper |
| **Quick launch** | open PowerShell or a console in a pasted folder |
| **Names and colours** | label every session, see it in every view |
| **German and English** | starts in your Windows language |

## How the agents cross over

Every Claude Code, Codex and OpenCode tile you start gets a small MCP server called `clio`:

| Tool | What the agent can do |
|---|---|
| `spawn_worker` | open Claude Code, Codex, OpenCode or a shell as a new tile, in any folder |
| `send`, `send_keys` | type a task into a tile, press keys |
| `wait_for_idle`, `wait_for` | wait until a tile is done, or until a text appears |
| `read_screen`, `read_tail` | read what a tile shows |
| `list_sessions` | see every tile and what it may control |
| `stop_worker` | end a worker it started |

Start an agent as **Orchestrator** and it splits your goal across workers from the start. Start it
as **Normal** and it works on its own, and opens helpers only when you ask for them.

### Rights are enforced by the app, not by the prompt

* An agent reads and types only into **its own workers** and into tiles **you unlocked** for AI tiles.
* It can only stop workers it started, at most 8 at a time.
* Workers get no tools, so agents cannot start agents that start agents.
* Everything an agent types into another tile is written to an audit log, with secrets masked.
* A Claude worker started in its parent's own folder gets Claude's "Trust this folder?" answered by
  the app. Anywhere else, you decide.

## Voice input

Hold `-` (a short tap still types a minus) or click **Speak**, talk, let go. The text lands in the
terminal you used last, **without Enter**, so you read it before sending. Recognition runs **locally**
with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) on your GPU (CPU works too). Your
voice never leaves your machine. Requires Python with the `faster-whisper` package on your PATH.

## Download

Grab the portable `.exe` from the [latest release](../../releases/latest). No installation needed.

Windows 10 or 11. To use agent tiles, install the CLIs you want (Claude Code, Codex, OpenCode) and
sign in to them as usual; CLI Organizer finds them on your PATH.

## Build from source

```bash
npm install
npm run dev          # app with hot reload
npm test             # unit tests
npm run test:win     # integration tests with real console windows
npm run test:e2e     # selftest, clean close and hard kill against the app
npm run dist         # portable exe in dist/
```

Built with Electron, React and TypeScript. Windows APIs through [koffi](https://koffi.dev),
terminals through [node-pty](https://github.com/microsoft/node-pty) and
[xterm.js](https://xtermjs.org).

## Limits

* Windows only.
* Terminals started as administrator can only be captured when CLI Organizer runs as administrator too.
* Windows Terminal is captured as a whole window, with all its tabs.
* Agents keep working only while they are working on your request. An orchestrator is not notified
  when a worker finishes after it has answered you; ask it again to collect results.
* Workspaces reopen terminals, not their scrollback: programs start fresh (AI CLIs can optionally
  resume their last conversation).

## License

[FSL-1.1-MIT](LICENSE.md), the Functional Source License.

In plain words: you may use, change and share CLI Organizer for anything except building a competing
commercial product from it. Two years after each release, that release becomes available under the
MIT license. The license text is the binding version.

Copyright 2026 Marco Sadjadi.
