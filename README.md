# Sonara

Tasks, voice dictation, and time tracking for VS Code - all stored as plain files inside your project. No account, no cloud, no telemetry. Everything runs locally.

![Sonara overview](./media/screenshots/overview.png)

Sonara adds a sidebar with three panels - **Tasks**, **Voice Log**, and **Voice Transcripts** - plus a **Time Tracker** in the status bar. Each project (workspace folder) keeps its own data under `.vscode/sonara/`.

## Features

### Tasks

Manage project tasks as plain markdown files - they travel with your repository.

- One markdown file per task with YAML frontmatter metadata
- Fields: title, status, priority, sprint, labels, created, updated
- Webview panel groups tasks by status: Activity, Inbox, Backlog, To Do, In Progress, Ready for Review, Done, Released, Cancelled
- Five priority levels: Highest, High, Medium, Low, Lowest
- Filter by sprint, label, and priority directly in the panel
- Create, edit, and delete tasks without leaving VS Code
- "Copy Agent Context" puts a task's details on the clipboard for pasting into an AI assistant
- Stored under `.vscode/sonara/tasks/` - commit them with your code or keep them local

### Voice

Dictate notes, prompts, and task descriptions with a local Whisper model. Audio is captured and transcribed entirely on your machine.

- Start/stop dictation with a single shortcut (`Ctrl+Shift+M`)
- Three streaming modes: classic (record then transcribe), live (transcribe as you speak), and adaptive (classic for short clips, live for long ones)
- The local transcription server starts only when you need it, can be toggled on/off from the status bar, and shuts itself down after a period of inactivity to free memory
- GPU (CUDA) acceleration when available; if the GPU runs out of memory mid-transcription, Sonara offers to retry on CPU or with a smaller model
- Project vocabulary biases Whisper toward your technical terms and proper names
- Voice Log keeps the full dictation history as JSONL - search, copy, and clear it from the panel
- No network connection required for recording or transcription

### Voice Transcripts

Transcribe pre-recorded audio or video files (meetings, debriefs, design reviews) into searchable markdown.

- Right-click an audio file or run `Sonara: Transcribe File...` from the Command Palette
- Each transcript is saved as a markdown file under `.vscode/sonara/voice-transcripts/`
- Metadata header captures source filename, duration, language, and creation date
- Webview panel lists all transcripts with timestamps and durations

### Time Tracking

Track time per task, stored as plain daily files.

- Start, stop, and toggle a timer from the Command Palette or the status bar
- Time accrues to the active task in small slots while the timer runs
- Per-day, per-user data stored as JSON under `.vscode/sonara/time-tracker/days/`
- Open today's file with `Sonara: Open Today's Time Tracker File`

## Requirements

- **VS Code** 1.85 or newer.
- **Voice recording currently runs on Linux only** (audio is captured via PulseAudio/PipeWire). Tasks and Time Tracking work on every platform; on macOS/Windows the voice commands show a clear message instead of recording.
- **GPU is optional but recommended.** A CUDA GPU gives fast transcription and is required for the live streaming phase. Without a GPU, transcription runs on CPU and is considerably slower.
- The first time the voice features activate, Sonara sets up a local Python environment and downloads the selected Whisper model (default `large-v3`, ~3 GB). This is the only step that needs the internet.

## Install

1. Download the latest `.vsix` from the [Releases](../../releases) page (or build it yourself - see [Building](#building)).
2. In VS Code: `Extensions` view → `...` menu → `Install from VSIX...` → pick the file.
3. Reload VS Code when prompted.

## Quick Start

1. **Open the sidebar.** Click the Sonara icon in the Activity Bar. Three panels appear: Tasks, Voice Log, Voice Transcripts. The `.vscode/sonara/` folder is created automatically the first time you use a feature.
2. **Create a task.** In the Tasks panel, click **New Task** (the `+` button), fill in the details, and it is saved as a markdown file.
3. **Dictate.** Press `Ctrl+Shift+M` to start. On first use the Whisper model downloads (one time). Speak, then press `Ctrl+Shift+M` again to stop and save the entry to the Voice Log.
4. **Multiple folders?** Use the **Active Project** selector at the top of the sidebar to switch between workspace folders - each keeps its own independent data.

## How the voice server works

Sonara bundles a local server that runs [faster-whisper](https://github.com/SYSTRAN/faster-whisper). It is managed automatically so it does not waste memory when you are not dictating:

- **Lazy start** - the server is not running until your first dictation or file transcription.
- **Status bar toggle** - a `Voice: On / Off` item lets you turn the server on or off at any time. Turning it off frees the model from memory immediately. While it is off, starting a recording asks whether you want to turn it back on.
- **Idle shutdown** - when on, the server shuts itself down after `sonara.voice.idleShutdownMinutes` of inactivity (default 10; set to 0 to never shut down) and starts again on your next dictation.
- **GPU out-of-memory recovery** - if a transcription runs out of GPU memory, a prompt offers to retry the recording on CPU or with a smaller model, then restores your usual model.

### Streaming modes

Set `sonara.voice.streamingMode` (or use `Sonara: Change Streaming Mode`):

- `off` - classic: record, stop, then transcribe in one shot. Best accuracy on short messages.
- `on` - live: transcribe continuously while you speak. Requires a CUDA GPU.
- `adaptive` - classic for short recordings, automatically switching to live once a recording passes `sonara.voice.adaptiveStreamingThresholdSec`. Requires a GPU for the live phase.

### Vocabulary

Edit `.vscode/sonara/vocabulary.md` (or run `Sonara: Edit Project Vocabulary`) to list technical terms, proper names, and project jargon - one term per line, `#` for comments. Whisper is biased toward these words across dictation and file transcription. Keep the list focused.

## Tasks file format

Each task is a `.md` file under `.vscode/sonara/tasks/`: a YAML frontmatter block followed by free-form markdown.

```markdown
---
title: Implement OAuth2 session refresh
status: in-progress
priority: high
sprint: Q2 Growth
labels: [backend, auth]
created: 2026-04-08T09:00:00Z
updated: 2026-04-10T16:45:00Z
---

<!-- Sonara task. Format and rules: .vscode/sonara/tasks/README.md -->

Task description in free-form markdown.
```

> The YAML frontmatter **must be the first thing in the file** - line 1 is `---`, with no leading comment or blank line. The Sonara hint comment belongs in the body, after the closing `---`. Field order inside the frontmatter does not matter (it is parsed by key); the order above is just the convention Sonara writes.

| Field | Required | Values |
|-------|----------|--------|
| `title` | No (filename used as fallback) | Any string |
| `status` | No (null if omitted or invalid) | `activity`, `inbox`, `backlog`, `todo`, `in-progress`, `review`, `done`, `released`, `cancelled` |
| `priority` | No (defaults to `medium`) | `highest`, `high`, `medium`, `low`, `lowest` |
| `created` | No | ISO 8601 date string |
| `updated` | No | ISO 8601 date string |
| `sprint` | No | Any string |
| `labels` | No | YAML array of strings |

A `README.md` describing the full format is generated inside `.vscode/sonara/tasks/` of every initialized project.

## Project files

Everything Sonara stores lives under `.vscode/sonara/` in each workspace folder:

| Path | Contents |
|------|----------|
| `tasks/` | One markdown file per task (+ a format `README.md`) |
| `voice-log/voice-log.jsonl` | Dictation history (one JSON record per line) |
| `vocabulary.md` | Project vocabulary that biases Whisper |
| `voice-transcripts/` | File transcripts as markdown |
| `time-tracker/days/` | Per-day time tracking data as JSON |

Whether you commit these is up to you - the extension does not touch your `.gitignore`. Voice data can contain personal recordings; consider excluding `voice-log/` and `voice-transcripts/` from shared repositories.

### Voice Log and time tracking formats

**Voice Log** - one JSON object per line in `voice-log/voice-log.jsonl`:

```json
{"id": "a1b2c3", "timestamp": "2026-06-04T18:30:00.000Z", "text": "Add login screen", "language": "uk", "duration_sec": 4.2, "model": "large-v3", "tags": [], "copied": false}
```

**Time tracking** - one file per user per day at `time-tracker/days/<user>/<YYYY-MM-DD>.json`:

```json
{
  "date": "2026-06-04",
  "tasks": {
    "implement-oauth2-session-refresh": {
      "total": 1800,
      "slots": [{ "start": "2026-06-04T09:00:00Z", "seconds": 900 }]
    }
  }
}
```

Within a day file, `slots` are chronological and `total` is their sum. As with task frontmatter, object key order is not significant - only the order of array items (the `slots` sequence) is.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+M` | Start / stop recording |
| `Ctrl+Alt+M` | Cancel recording (discard audio) |

## Configuration

Open Settings (`Ctrl+,`) and search for `sonara`. Full list:

| Setting | Default | Description |
|---------|---------|-------------|
| `sonara.voice.model` | `large-v3` | Whisper model (`tiny`, `base`, `small`, `medium`, `large-v2`, `large-v3`) |
| `sonara.voice.device` | `auto` | Compute device (`auto`, `cuda:0`, `cuda:1`, `cpu`) |
| `sonara.voice.language` | `auto` | Transcription language, or `auto` to detect (23 languages available) |
| `sonara.voice.computeType` | `auto` | faster-whisper compute type (`auto`, `float16`, `int8_float16`, `int8`, `float32`) |
| `sonara.voice.vadFilter` | `true` | Voice activity detection filter |
| `sonara.voice.audioInput` | `null` | Input device (`null` = system default; pick via `Sonara: Change Audio Input`) |
| `sonara.voice.stopDelayMs` | `1000` | Extra capture time (ms) after Stop, so trailing words are not cut off |
| `sonara.voice.streamingMode` | `off` | `off` (classic), `on` (live), or `adaptive` |
| `sonara.voice.adaptiveStreamingThresholdSec` | `30` | In adaptive mode, switch to live after this many seconds |
| `sonara.voice.streamingIntervalSec` | `2` | How often (s) live transcription emits a partial result |
| `sonara.voice.beamSize` | `5` | Whisper beam size |
| `sonara.voice.idleShutdownMinutes` | `10` | Idle minutes before the server shuts down (`0` = never) |
| `sonara.voice.log.autoOpenPanel` | `false` | Auto-open the Voice Log panel on start |
| `sonara.voice.log.showNotificationOnTranscribe` | `true` | Toast after each transcription |
| `sonara.timeTracker.tickIntervalSec` | `15` | How often (s) time is credited while a timer runs |
| `sonara.timeTracker.flushIntervalSec` | `60` | How often (s) pending time is written to disk |

## Privacy

Voice data never leaves your machine. Audio is captured locally, transcribed by the bundled Whisper server on `localhost`, and the dictation text is stored in `.vscode/sonara/voice-log/voice-log.jsonl` inside your project. Audio is not retained after transcription. No telemetry is collected.

## Building

Requires Docker (the build runs in a container) and the VS Code `code` CLI.

```sh
make build        # compile + package into sonara-<version>.vsix
make install-ext  # install the built .vsix into local VS Code
```

Run `make help` for all targets.

## License

See [LICENSE](./LICENSE).
