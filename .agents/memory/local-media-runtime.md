---
name: Local media runtime
description: Portable discovery rules for local FFmpeg and Faster-Whisper runtimes in this workspace.
---

The API should discover local executables relative to both the current package directory and the workspace root, while allowing explicit environment overrides for Windows and custom installations.

**Why:** Managed workflows can run with a package directory as their working directory even when language runtimes are installed at the workspace root.

**How to apply:** Prefer `FFMPEG_BIN`, `FFPROBE_BIN`, `PYTHON_BIN`, and `WHISPER_SCRIPT` overrides; otherwise check platform-appropriate virtualenv locations before falling back to PATH.