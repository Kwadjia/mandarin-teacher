"""Local speech-scoring service. Holds the model in memory so scoring is one request.

    python pipeline/speech_server.py

Exists as a separate process for one reason: loading large-v3 takes ~50 seconds, and
the alternative — shelling out to Python per attempt — would pay that on every rep.
Here it is paid once at startup and each attempt costs a few hundred milliseconds.

Deliberately stdlib-only. This is a single-user service on localhost that answers one
route; FastAPI and uvicorn would be two more dependencies to install, pin and explain
for no behaviour the learner can observe.

  GET  /health          → {ok, model, ready}
  POST /score           → measurements for one attempt
       multipart/form-data: audio=<recording>, hanzi=…, pinyin=…, reference=<path>

Nothing leaves the machine. The recordings are the user's own voice, and keeping the
scorer local means that stays true by construction rather than by policy.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
from email.parser import BytesParser
from email.policy import default as email_default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import speech_score as ss  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# 8788 is taken on this machine by another dev server, and Windows let this one bind
# beside it rather than refuse — see Server below.
PORT = int(os.environ.get("MT_SPEECH_PORT", "8790"))
AUDIO_DIR = Path(__file__).resolve().parent / "out" / "day0"

# Scoring is serialised. Threads still serve /health promptly while an attempt is in
# flight, but two attempts must not overlap: they would hit CTranslate2 concurrently
# and, more concretely, both write the same scratch WAV. One learner cannot speak
# twice at once, so this costs nothing real.
SCORING = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's naming
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "model": ss.MODEL_NAME, "ready": ss.loaded()})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.startswith("/score"):
            self._send(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("content-length", 0))
            if not length:
                self._send(400, {"error": "empty body"})
                return

            # Reconstruct a MIME document so the stdlib parser can split the parts.
            header = f"content-type: {self.headers.get('content-type')}\r\n\r\n".encode()
            msg = BytesParser(policy=email_default).parsebytes(header + self.rfile.read(length))

            fields: dict[str, str] = {}
            audio: bytes | None = None
            for part in msg.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if name == "audio":
                    audio = part.get_payload(decode=True)
                elif name:
                    fields[name] = part.get_payload(decode=True).decode("utf-8")

            if not audio:
                self._send(400, {"error": "no audio part"})
                return
            hanzi = fields.get("hanzi", "").strip()
            if not hanzi:
                self._send(400, {"error": "hanzi is required"})
                return

            # The reference is named by the client but resolved here, and confined to
            # the audio directory — an HTTP-supplied path must never be able to reach
            # the rest of the disk, even on localhost.
            ref = None
            if name_ := fields.get("reference", "").strip():
                candidate = (AUDIO_DIR / Path(name_).name).resolve()
                if candidate.is_file() and candidate.is_relative_to(AUDIO_DIR.resolve()):
                    ref = candidate

            t0 = time.perf_counter()
            with SCORING:
                result = ss.score(audio, hanzi, fields.get("pinyin", ""), ref)
            result["elapsedMs"] = round((time.perf_counter() - t0) * 1000)
            result["referenceUsed"] = ref.name if ref else None
            self._send(200, result)

        except Exception as e:  # noqa: BLE001 — a scoring failure must not kill the server
            traceback.print_exc()
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt: str, *args) -> None:
        # The default logs every request to stderr; only failures are interesting here.
        if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            sys.stderr.write(f"speech: {fmt % args}\n")


class Server(ThreadingHTTPServer):
    """Refuse to start on a port someone else already owns.

    ThreadingHTTPServer sets allow_reuse_address, which on Windows means SO_REUSEADDR
    lets a second socket bind a port that is already listening — and then delivers the
    connections to whichever socket the OS prefers. This server bound happily next to
    an unrelated dev server on 8788, reported itself ready, and silently received no
    traffic at all. Failing to start is enormously easier to diagnose.
    """

    allow_reuse_address = False


def main() -> int:
    # Bind before loading the model: a port conflict should surface in a second rather
    # than after a minute of GPU work, and "ready" must not be printed before it is.
    try:
        server = Server(("127.0.0.1", PORT), Handler)
    except OSError as e:
        print(f"Cannot listen on 127.0.0.1:{PORT} — {e}")
        print(f"  Something else is using it. Find it with:")
        print(f"    Get-NetTCPConnection -LocalPort {PORT} -State Listen")
        print(f"  or choose another:  MT_SPEECH_PORT=8791 npm run speech")
        return 1

    print(f"loading {ss.MODEL_NAME} …", flush=True)
    t0 = time.perf_counter()
    try:
        ss.model()
    except Exception as e:  # noqa: BLE001
        print(f"\nFailed to load the model on CUDA: {type(e).__name__}: {e}")
        print("Check pipeline/check_gpu_speech.py — it isolates whether CUDA is the problem.")
        return 1
    print(f"ready in {time.perf_counter() - t0:.1f}s · http://localhost:{PORT}", flush=True)
    print(f"  temp audio → {ss.TMP}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
