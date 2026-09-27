import argparse
import json
import os
import sys


def emit(payload):
    print(json.dumps(payload), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default=os.getenv("WHISPER_MODEL", "small"))
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(f"Unable to import faster-whisper: {exc}", file=sys.stderr)
        return 2

    try:
        device = os.getenv("WHISPER_DEVICE", "auto")
        compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
        model = WhisperModel(args.model, device=device, compute_type=compute_type)
        segments, info = model.transcribe(
            args.input,
            beam_size=int(os.getenv("WHISPER_BEAM_SIZE", "5")),
            word_timestamps=True,
            vad_filter=True,
        )

        duration = float(info.duration) if info.duration else None
        transcript_segments = []

        for index, segment in enumerate(segments):
            words = []
            for word in segment.words or []:
                words.append(
                    {
                        "word": word.word,
                        "start": float(word.start),
                        "end": float(word.end),
                        "probability": (
                            float(word.probability)
                            if word.probability is not None
                            else None
                        ),
                    }
                )

            transcript_segments.append(
                {
                    "id": index,
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": segment.text.strip(),
                    "words": words,
                }
            )

            progress = 0.0
            if duration and duration > 0:
                progress = min(99.0, max(0.0, (float(segment.end) / duration) * 100))
            emit({"type": "progress", "progress": progress})

        transcript = {
            "language": info.language,
            "durationSeconds": duration,
            "segments": transcript_segments,
        }
        with open(args.output, "w", encoding="utf-8") as output_file:
            json.dump(transcript, output_file, ensure_ascii=False, indent=2)
        emit({"type": "complete", "output": args.output})
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())