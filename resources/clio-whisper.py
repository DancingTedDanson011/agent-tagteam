# Speech-to-text worker for CLI Organizer's voice input. Started once by the app and kept running
# (the model loads once). Protocol: one JSON object per line on stdin
#   {"id": "...", "path": "<audio file>", "lang": "de" | "en" | null}
# and one JSON object per line on stdout
#   {"ready": true, "device": "cuda"}              once the model is loaded
#   {"id": "...", "text": "..."} or {"id": "...", "error": "..."}
# Nothing else is ever printed to stdout (logs go to stderr).
import json
import sys


def main() -> None:
    # The protocol is UTF-8 JSON. Windows would decode stdin as cp1252 and break every path with an
    # umlaut (C:\Users\Jörg\...) unless PYTHONIOENCODING happens to be set (cold review).
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    model_name = sys.argv[1] if len(sys.argv) > 1 else "large-v3-turbo"
    try:
        from faster_whisper import WhisperModel
    except Exception as err:  # the app tells the user what is missing
        print(json.dumps({"fatal": f"faster-whisper not available: {err}"}), flush=True)
        return
    device = "cuda"
    try:
        model = WhisperModel(model_name, device="cuda", compute_type="float16")
    except Exception as err:
        print(f"cuda unavailable, using cpu: {err}", file=sys.stderr, flush=True)
        device = "cpu"
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
    print(json.dumps({"ready": True, "device": device}), flush=True)

    for line in sys.stdin:
        try:
            req = json.loads(line)
            rid = str(req["id"])
        except Exception:
            continue
        try:
            lang = req.get("lang") or None
            segments, _info = model.transcribe(req["path"], language=lang, vad_filter=True, beam_size=5)
            text = " ".join(s.text.strip() for s in segments).strip()
            print(json.dumps({"id": rid, "text": text}), flush=True)
        except Exception as err:
            print(json.dumps({"id": rid, "error": str(err)}), flush=True)


if __name__ == "__main__":
    main()
