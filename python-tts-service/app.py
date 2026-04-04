"""
Anime Video Generator — TTS Microservice v2.1
Port: 5050

FIXES:
  - edge-tts 403: upgrade check + clearer error message
  - Added Kokoro TTS as second neural-quality fallback (offline, no network needed)
  - gTTS remains final fallback
  - Auto-cleanup of output files older than 1 hour (prevents disk fill)
"""

import os
import sys
import uuid
import subprocess
import json
import time
import threading
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

VOICES = {
    "male_en":           "en-US-GuyNeural",
    "female_en":         "en-US-JennyNeural",
    "male_en_dramatic":  "en-US-DavisNeural",
    "female_en_bright":  "en-US-AriaNeural",
    "male_jp":           "ja-JP-KeitaNeural",
    "female_jp":         "ja-JP-NanamiNeural",
    "male_in":           "en-IN-PrabhatNeural",
    "female_in":         "en-IN-NeerjaNeural",
}

# ---------------------------------------------------------------------------
# Auto-cleanup: remove TTS files older than 1 hour to prevent disk fill
# ---------------------------------------------------------------------------

def _cleanup_old_files():
    while True:
        try:
            now = time.time()
            for fname in os.listdir(OUTPUT_DIR):
                fpath = os.path.join(OUTPUT_DIR, fname)
                if os.path.isfile(fpath) and (now - os.path.getmtime(fpath)) > 3600:
                    os.remove(fpath)
        except Exception:
            pass
        time.sleep(300)  # check every 5 minutes

threading.Thread(target=_cleanup_old_files, daemon=True).start()

# ---------------------------------------------------------------------------
# edge-tts worker — runs in a subprocess to avoid asyncio/fork issues
# ---------------------------------------------------------------------------
WORKER_SCRIPT = r"""
import sys, asyncio, json

async def run(text, voice, rate, out_path):
    import edge_tts
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(out_path)

if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    try:
        asyncio.run(run(args["text"], args["voice"], args["rate"], args["out_path"]))
        print(json.dumps({"ok": True}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
"""


def _run_edge_tts(text: str, voice: str, rate: str, output_path: str) -> None:
    """Run edge-tts in an isolated subprocess. Raises RuntimeError on failure."""
    payload = json.dumps({
        "text": text, "voice": voice, "rate": rate, "out_path": output_path
    })
    result = subprocess.run(
        [sys.executable, "-c", WORKER_SCRIPT],
        input=payload,
        capture_output=True,
        text=True,
        timeout=60,
    )
    stdout = result.stdout.strip()
    if not stdout:
        raise RuntimeError(
            f"edge-tts worker produced no output.\nstderr: {result.stderr[:500]}"
        )
    data = json.loads(stdout)
    if not data.get("ok"):
        err_msg = data.get("error", "unknown")
        # FIX: provide actionable fix hint for the 403 token-rotation error
        if "403" in err_msg or "Invalid response status" in err_msg:
            raise RuntimeError(
                f"edge-tts 403 — Microsoft rotated the auth token. "
                f"Fix: pip install --upgrade edge-tts\n(original: {err_msg})"
            )
        raise RuntimeError(f"edge-tts error: {err_msg}")
    if not os.path.exists(output_path) or os.path.getsize(output_path) < 100:
        raise RuntimeError("edge-tts ran but output file is missing or empty")


# ---------------------------------------------------------------------------
# Kokoro TTS (optional offline neural fallback — better quality than gTTS)
# ---------------------------------------------------------------------------

def _try_kokoro_tts(text: str, output_path: str) -> bool:
    """
    Attempt to use kokoro-onnx for offline neural TTS.
    Returns True on success, False if kokoro is not installed.
    """
    try:
        import kokoro
        import soundfile as sf
        import numpy as np

        # kokoro uses en-us voice by default
        pipeline = kokoro.KPipeline(lang_code="a")  # 'a' = American English
        audio_chunks = []
        for _, _, audio in pipeline(text, voice="af_sky", speed=1.1):
            audio_chunks.append(audio)

        if not audio_chunks:
            return False

        combined = np.concatenate(audio_chunks)
        # kokoro outputs at 24kHz; save as wav then convert to mp3 via ffmpeg
        wav_path = output_path.replace(".mp3", "_tmp.wav")
        sf.write(wav_path, combined, 24000)

        subprocess.run(
            ["ffmpeg", "-y", "-i", wav_path, "-q:a", "4", output_path],
            capture_output=True, timeout=30
        )
        if os.path.exists(wav_path):
            os.remove(wav_path)

        return os.path.exists(output_path) and os.path.getsize(output_path) > 100
    except ImportError:
        return False
    except Exception as e:
        print(f"   ⚠️  Kokoro TTS failed: {e}")
        return False


# ---------------------------------------------------------------------------
# Main TTS function — tries engines in order: edge-tts → kokoro → gTTS
# ---------------------------------------------------------------------------

def generate_tts(text: str, voice: str = "en-US-GuyNeural",
                 rate: str = "+0%", output_path: str = None) -> str:
    if output_path is None:
        output_path = os.path.join(OUTPUT_DIR, f"tts_{uuid.uuid4().hex[:8]}.mp3")

    edge_err = None

    # 1 — Try edge-tts (Microsoft neural voices, best quality)
    try:
        _run_edge_tts(text, voice, rate, output_path)
        size = os.path.getsize(output_path)
        print(f"   ✅ edge-tts OK: {os.path.basename(output_path)} ({size:,} bytes)")
        return output_path
    except Exception as e:
        edge_err = str(e)
        print(f"   ⚠️  edge-tts failed: {edge_err}")
        if os.path.exists(output_path):
            os.remove(output_path)

    # 2 — Try Kokoro (offline neural, good quality, optional)
    print("   🔄 Trying Kokoro TTS fallback...")
    if _try_kokoro_tts(text, output_path):
        size = os.path.getsize(output_path)
        print(f"   ✅ Kokoro TTS OK: {os.path.basename(output_path)} ({size:,} bytes)")
        return output_path

    # 3 — Fall back to gTTS (online, lower quality but always works)
    print("   🔄 Trying gTTS fallback...")
    try:
        import warnings
        warnings.filterwarnings("ignore")
        from gtts import gTTS
        gTTS(text=text, lang="en", slow=False).save(output_path)
        if os.path.exists(output_path) and os.path.getsize(output_path) > 100:
            size = os.path.getsize(output_path)
            print(f"   ✅ gTTS fallback OK: {os.path.basename(output_path)} ({size:,} bytes)")
            return output_path
        raise RuntimeError("gTTS produced empty file")
    except Exception as gtts_err:
        raise RuntimeError(
            f"All TTS engines failed.\n"
            f"  edge-tts → {edge_err}\n"
            f"  kokoro   → not installed (pip install kokoro soundfile)\n"
            f"  gTTS     → {gtts_err}"
        )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    # Report which engines are available
    engines = ["gTTS"]
    try:
        import edge_tts  # noqa
        engines.insert(0, "edge-tts")
    except ImportError:
        pass
    try:
        import kokoro  # noqa
        engines.insert(1, "kokoro")
    except ImportError:
        pass
    return jsonify({"status": "ok", "service": "tts-service", "port": 5050, "engines": engines})


@app.route("/voices", methods=["GET"])
def list_voices():
    return jsonify({"voices": VOICES})


@app.route("/tts", methods=["POST"])
def text_to_speech():
    data = request.get_json(force=True, silent=True) or {}
    text = data.get("text", "").strip()

    if not text:
        return jsonify({"error": "Missing or empty 'text' field"}), 400
    if len(text) > 5000:
        return jsonify({"error": "Text too long (max 5000 chars)"}), 400

    voice = VOICES.get(data.get("voice", "male_en"), VOICES["male_en"])
    rate  = data.get("rate", "+0%")
    out   = os.path.join(OUTPUT_DIR, f"tts_{uuid.uuid4().hex[:8]}.mp3")

    try:
        generate_tts(text, voice, rate, out)
        return send_file(out, mimetype="audio/mpeg", as_attachment=True,
                         download_name=os.path.basename(out))
    except Exception as e:
        print(f"❌ /tts error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/tts/save", methods=["POST"])
def tts_save():
    data = request.get_json(force=True, silent=True) or {}
    text = data.get("text", "").strip()

    if not text:
        return jsonify({"error": "Missing or empty 'text' field"}), 400

    voice    = VOICES.get(data.get("voice", "male_en"), VOICES["male_en"])
    rate     = data.get("rate", "+0%")
    filename = f"tts_{uuid.uuid4().hex[:8]}.mp3"
    out_path = os.path.join(OUTPUT_DIR, filename)

    print(f"\n📨 /tts/save called — voice={voice}, rate={rate}, text_len={len(text)}")

    try:
        generate_tts(text, voice, rate, out_path)
        return jsonify({
            "success":      True,
            "filename":     filename,
            "path":         out_path,
            "download_url": f"/tts/download/{filename}",
        })
    except Exception as e:
        print(f"❌ /tts/save error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/tts/download/<filename>", methods=["GET"])
def download_tts(filename):
    safe = os.path.basename(filename)
    fp   = os.path.join(OUTPUT_DIR, safe)
    if not os.path.exists(fp):
        return jsonify({"error": "File not found"}), 404
    return send_file(fp, mimetype="audio/mpeg")


if __name__ == "__main__":
    port = int(os.environ.get("TTS_PORT", 5050))
    print(f"🎤 TTS Service running on http://localhost:{port}")
    print(f"   Upgrade edge-tts if you see 403 errors: pip install --upgrade edge-tts")
    app.run(host="0.0.0.0", port=port, debug=True, use_reloader=False)
