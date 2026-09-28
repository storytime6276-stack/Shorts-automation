"""Offline person detection/tracking for deterministic portrait crop framing."""

import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--start", required=True, type=float)
    parser.add_argument("--end", required=True, type=float)
    args = parser.parse_args()

    try:
        import cv2
    except Exception as exc:
        print(f"OpenCV subject detection is unavailable: {exc}", file=sys.stderr)
        return 2

    capture = cv2.VideoCapture(args.input)
    if not capture.isOpened():
        print("OpenCV could not open the source video.", file=sys.stderr)
        return 2

    try:
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(capture.get(cv2.CAP_PROP_FPS)) or 30.0
        duration = max(0.0, args.end - args.start)
        interval = 1.25
        expected_count = max(1, int(duration / interval) + 1)
        hog = cv2.HOGDescriptor()
        hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        samples = []
        previous_center = None

        for sample_index in range(expected_count):
            offset = min(duration, sample_index * interval)
            capture.set(cv2.CAP_PROP_POS_MSEC, (args.start + offset) * 1000.0)
            ok, frame = capture.read()
            if not ok or frame is None:
                continue
            scale = min(1.0, 640.0 / max(frame.shape[1], frame.shape[0]))
            if scale < 1.0:
                frame = cv2.resize(
                    frame,
                    (max(1, int(round(frame.shape[1] * scale))), max(1, int(round(frame.shape[0] * scale)))),
                    interpolation=cv2.INTER_AREA,
                )
            boxes, weights = hog.detectMultiScale(
                frame,
                hitThreshold=0.0,
                winStride=(8, 8),
                padding=(8, 8),
                scale=1.05,
            )
            candidates = []
            diagonal = max(1.0, (frame.shape[1] ** 2 + frame.shape[0] ** 2) ** 0.5)
            for (x, y, box_width, box_height), raw_weight in zip(boxes, weights):
                ratio = box_width / max(1.0, box_height)
                if box_height < 64 or ratio < 0.16 or ratio > 0.9:
                    continue
                raw = float(raw_weight[0] if hasattr(raw_weight, "__len__") else raw_weight)
                confidence = max(0.0, min(1.0, (raw + 1.0) / 2.0))
                if confidence < 0.45:
                    continue
                cx = (x + box_width / 2.0) / frame.shape[1]
                cy = (y + box_height / 2.0) / frame.shape[0]
                if previous_center is not None:
                    distance = (((cx - previous_center[0]) * frame.shape[1]) ** 2 + ((cy - previous_center[1]) * frame.shape[0]) ** 2) ** 0.5 / diagonal
                    if distance > 0.45:
                        continue
                    confidence -= distance * 0.25
                size_score = min(1.0, box_height / max(1.0, frame.shape[0] * 0.8))
                candidates.append((confidence + size_score * 0.12, cx, cy, confidence))

            if not candidates:
                continue
            _, cx, cy, confidence = max(candidates, key=lambda item: (item[0], -item[1], -item[2]))
            previous_center = (cx, cy)
            samples.append({"timeSeconds": offset, "centerX": cx, "centerY": cy, "confidence": max(0.0, min(1.0, confidence))})

        print(json.dumps({"width": width, "height": height, "fps": fps, "durationSeconds": duration, "expectedSampleCount": expected_count, "samples": samples}))
        return 0
    finally:
        capture.release()


if __name__ == "__main__":
    raise SystemExit(main())
