# Shorts Studio

Local-first video processing for validating Shorts media, extracting audio, and creating word-level Faster-Whisper transcripts.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/shorts-studio run dev` — run the Shorts Studio UI
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Local media runtime

- `FFMPEG_BIN`, `FFPROBE_BIN`, `PYTHON_BIN`, and `WHISPER_SCRIPT` override executable/script paths for Windows or custom installations.
- `WHISPER_MODEL` defaults to `small`; `WHISPER_DEVICE` defaults to `auto`; `WHISPER_COMPUTE_TYPE` defaults to `int8`.
- `SHORTS_WORKSPACE_DIR` controls where uploaded videos, extracted WAV files, job metadata, and `transcript.json` are saved. It defaults to `./shorts-workspace`.
- The local Python runtime is tracked by `pyproject.toml`/`uv.lock`; install Faster-Whisper into the environment before running the API on another machine.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Media: FFmpeg/ffprobe + local Faster-Whisper
- Validation: Zod (`zod/v4`)
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/shorts-studio/src/App.tsx` — upload workspace, job status, and transcript viewer.
- `artifacts/api-server/src/media/pipeline.ts` — portable local job store and FFmpeg/Faster-Whisper pipeline.
- `artifacts/api-server/src/media/transcribe.py` — Faster-Whisper word timestamp runner.
- `lib/api-spec/openapi.yaml` — source of truth for job, status, and transcript endpoints.

## Architecture decisions

- Processing files stay on the local filesystem instead of object storage or a paid media API.
- Uploads use `application/octet-stream` with an `X-File-Name` header so browser, CLI, and eventual Windows clients can share the same endpoint without multipart parser coupling.
- Jobs persist as JSON metadata inside each workspace job directory, allowing status and transcript artifacts to survive API restarts.
- Faster-Whisper runs as a separate Python process so the Node API remains portable and the transcription runtime can be replaced or configured independently.

## Product

Shorts Studio accepts local video uploads, validates them with ffprobe, extracts mono 16 kHz WAV audio with FFmpeg, transcribes locally with Faster-Whisper, and displays word-level timing in the UI.

## User preferences

Keep video processing local; do not add paid APIs or cloud video storage.

## Gotchas

- The API must be restarted after backend or dependency changes so its bundled runtime and managed workflow pick them up.
- The first Faster-Whisper run may download the selected model into the local Python cache.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
