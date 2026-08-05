#!/usr/bin/env python3
"""Polaris audio engine: Kokoro TTS + XTTS-v2 voice cloning, stdlib-only HTTP."""
import argparse
import base64
import json
import os
import re
import subprocess
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OUT_DIR = Path(os.environ.get("AUDIO_OUT_DIR", str(Path.home() / "PolarisAudio")))
VOICES_DIR = Path(os.environ.get("AUDIO_VOICES_DIR", str(OUT_DIR / "voices")))
Q3TTS_BIN = os.environ.get("Q3TTS_BIN", "")
Q3_CODEC = os.environ.get("Q3_CODEC", "")
GGML_BACKEND = os.environ.get("GGML_BACKEND", "Vulkan0")
os.environ.setdefault("COQUI_TOS_AGREED", "1")  # XTTS-v2 license prompt is interactive; auto-accept for server use
OUT_DIR.mkdir(parents=True, exist_ok=True)
VOICES_DIR.mkdir(parents=True, exist_ok=True)

Q3_LANGS = ["English", "Mandarin Chinese", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian"]

LANGS = {
    "a": "English (US)", "b": "English (UK)", "j": "Japanese", "z": "Chinese",
    "e": "Spanish", "f": "French", "h": "Hindi", "i": "Italian", "p": "Portuguese (BR)",
}
KOKORO_VOICES = [  # id, label, lang code
    ("af_heart", "Heart", "a"), ("af_alloy", "Alloy", "a"), ("af_aoede", "Aoede", "a"),
    ("af_bella", "Bella", "a"), ("af_jessica", "Jessica", "a"), ("af_kore", "Kore", "a"),
    ("af_nicole", "Nicole", "a"), ("af_nova", "Nova", "a"), ("af_river", "River", "a"),
    ("af_sarah", "Sarah", "a"), ("af_sky", "Sky", "a"),
    ("am_adam", "Adam", "a"), ("am_echo", "Echo", "a"), ("am_eric", "Eric", "a"),
    ("am_fenrir", "Fenrir", "a"), ("am_liam", "Liam", "a"), ("am_michael", "Michael", "a"),
    ("am_onyx", "Onyx", "a"), ("am_puck", "Puck", "a"), ("am_santa", "Santa", "a"),
    ("bf_alice", "Alice", "b"), ("bf_emma", "Emma", "b"), ("bf_isabella", "Isabella", "b"),
    ("bf_lily", "Lily", "b"), ("bm_daniel", "Daniel", "b"), ("bm_fable", "Fable", "b"),
    ("bm_george", "George", "b"), ("bm_lewis", "Lewis", "b"),
    ("jf_alpha", "Alpha", "j"), ("jf_gongitsune", "Gongitsune", "j"), ("jf_nezumi", "Nezumi", "j"),
    ("jf_tebukuro", "Tebukuro", "j"), ("jm_kumo", "Kumo", "j"),
    ("zf_xiaobei", "Xiaobei", "z"), ("zf_xiaoni", "Xiaoni", "z"),
    ("zf_xiaoxiao", "Xiaoxiao", "z"), ("zf_xiaoyi", "Xiaoyi", "z"),
    ("zm_yunjian", "Yunjian", "z"), ("zm_yunxi", "Yunxi", "z"),
    ("zm_yunxia", "Yunxia", "z"), ("zm_yunyang", "Yunyang", "z"),
    ("ef_dora", "Dora", "e"), ("em_alex", "Alex", "e"), ("em_santa", "Santa", "e"),
    ("ff_siwis", "Siwis", "f"),
    ("hf_alpha", "Alpha", "h"), ("hf_beta", "Beta", "h"),
    ("hm_omega", "Omega", "h"), ("hm_psi", "Psi", "h"),
    ("if_sara", "Sara", "i"), ("im_nicola", "Nicola", "i"),
    ("pf_dora", "Dora", "p"), ("pm_alex", "Alex", "p"), ("pm_santa", "Santa", "p"),
]
KOKORO = {vid: (label, lang) for vid, label, lang in KOKORO_VOICES}
_lock = threading.Lock()
_pipes = {}
_xtts = None
_xtts_error = None
_loading = False


def cloned_voices():
    return sorted(p.stem for p in VOICES_DIR.glob("*.wav"))


def pipe_for(lang):
    if lang not in _pipes:
        from kokoro import KPipeline
        _pipes[lang] = KPipeline(lang_code=lang)
    return _pipes[lang]


def load_xtts():
    """Load XTTS-v2 once (heavy ~2GB first run). Raises with a cached message on failure."""
    global _xtts, _xtts_error, _loading
    if _xtts is not None:
        return _xtts
    if _xtts_error is not None:
        raise RuntimeError(_xtts_error)
    if not _loading:
        _loading = True
        try:
            from TTS.api import TTS
            _xtts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        except Exception as e:
            _xtts_error = f"XTTS load failed: {e}"
            raise RuntimeError(_xtts_error)
        finally:
            _loading = False
    while _loading:
        time.sleep(0.2)
    return _xtts


def synth_kokoro(text, voice, speed, out_wav):
    label, lang = KOKORO[voice]
    kp = pipe_for(lang)
    frames = list(kp(text, voice=voice, speed=float(speed)))
    import numpy as np
    import soundfile as sf
    audio = np.concatenate([f.audio.numpy() for f in frames])
    sf.write(str(out_wav), audio, 24000)
    return wav_duration(out_wav, 24000)


def synth_xtts(text, voice, speed, out_wav):
    ref = VOICES_DIR / f"{voice}.wav"
    if not ref.exists():
        raise ValueError(f"unknown voice: {voice}")
    api = load_xtts()
    api.tts_to_file(text, speaker_wav=str(ref), language="en", file_path=str(out_wav))
    return wav_duration(out_wav)


def wav_duration(path, sr=None):
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / w.getframerate(), 2)
    except Exception:
        return 0.0


def find_codec(talker):
    """Qwen3-TTS needs the shared 12Hz tokenizer GGUF; env path first, then beside the talker."""
    if Q3_CODEC and Path(Q3_CODEC).exists():
        return Q3_CODEC
    for f in sorted(Path(talker).parent.glob("qwen-tokenizer-12hz*.gguf")):
        return str(f)
    raise RuntimeError("qwen-tokenizer-12hz GGUF not found next to the talker (or set engines.audio.q3Codec)")


def synth_qwen3(text, talker, lang, voice, out_wav):
    if not Q3TTS_BIN or not Path(Q3TTS_BIN).exists():
        raise RuntimeError(f"qwen3 binary missing: {Q3TTS_BIN} (set engines.audio.qwen3Binary)")
    cmd = [Q3TTS_BIN, "--model", talker, "--codec", find_codec(talker), "--lang", lang, "-o", str(out_wav)]
    if voice and voice != "default":
        ref = VOICES_DIR / f"{voice}.wav"
        if not ref.exists():
            raise ValueError(f"unknown voice: {voice}")
        cmd += ["--ref-wav", str(ref), "--ref-text", str(VOICES_DIR / f"{voice}.txt")]
    env = {**os.environ, "GGML_BACKEND": GGML_BACKEND}
    try:
        proc = subprocess.run(cmd, input=text, text=True, capture_output=True, timeout=600, env=env)
    except subprocess.TimeoutExpired:
        raise RuntimeError("qwen3 synthesis timed out (600s)")
    if proc.returncode != 0:
        raise RuntimeError(f"qwen-tts failed: {(proc.stderr or proc.stdout)[-800:]}")
    return wav_duration(out_wav)


def to_mp3(wav, mp3):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-codec:a", "libmp3lame", "-q:a", "2", str(mp3)], check=True)
    return mp3


def slug(name):
    return re.sub(r"[^a-zA-Z0-9_-]", "_", name.strip())[:64] or "voice"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n)) if n else {}

    def do_GET(self):
        if self.path == "/audio/health":
            return self._json({"ok": True, "voiceModels": len(KOKORO), "cloned": cloned_voices()})
        if self.path == "/audio/voices":
            voices = [{"id": vid, "label": label, "group": LANGS[lang]} for vid, label, lang in KOKORO_VOICES]
            for v in cloned_voices():
                voices.insert(0, {"id": v, "label": v, "group": "Cloned"})
            return self._json({"voices": voices, "dir": str(OUT_DIR)})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        body = self._read()
        if self.path == "/audio/tts":
            text = str(body.get("text", "")).strip()
            voice = str(body.get("voice", "am_liam"))
            speed = float(body.get("speed", 1.0))
            fmt = str(body.get("format", "wav"))
            model = str(body.get("model", "kokoro"))
            lang = str(body.get("lang", "English"))
            if not text:
                return self._json({"error": "empty text"}, 400)
            ts = str(int(time.time() * 1000))
            wav = OUT_DIR / f"tts_{ts}.wav"
            try:
                with _lock:
                    if model in ("", "kokoro"):
                        if voice in KOKORO:
                            sr = synth_kokoro(text, voice, speed, wav)
                        else:
                            sr = synth_xtts(text, voice, speed, wav)
                    else:
                        sr = synth_qwen3(text, model, lang, voice, wav)
            except Exception as e:
                return self._json({"error": str(e)}, 500)
            final = to_mp3(wav, OUT_DIR / f"tts_{ts}.mp3") if fmt == "mp3" else wav
            audio_b64 = base64.b64encode(final.read_bytes()).decode()
            return self._json({"ok": True, "file": str(final), "duration": sr, "audioB64": audio_b64})
        if self.path == "/audio/clone":
            name = slug(body.get("name", "voice"))
            raw = body.get("audioB64", "")
            transcript = str(body.get("transcript", "")).strip()
            tmp = VOICES_DIR / f".{name}.tmp.wav"
            try:
                data = base64.b64decode(raw)
                if data[:4] == b"RIFF":
                    tmp.write_bytes(data)
                else:
                    # ref clips are often mp3/webm/m4a — normalize to a real WAV first
                    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", "-",
                                    "-ar", "16000", "-ac", "1", str(tmp)],
                                   input=data, capture_output=True, check=True)
                if wav_duration(tmp) < 1.0:
                    tmp.unlink(missing_ok=True)
                    return self._json({"error": "clip too short (<1s)"}, 400)
                tmp.rename(VOICES_DIR / f"{name}.wav")
                if transcript:
                    (VOICES_DIR / f"{name}.txt").write_text(transcript)
            except subprocess.CalledProcessError as e:
                tmp.unlink(missing_ok=True)
                detail = (e.stderr or b"").decode(errors="replace")[:160]
                return self._json({"error": "reference audio could not be decoded: " + detail}, 400)
            except Exception as e:
                tmp.unlink(missing_ok=True)
                return self._json({"error": str(e)}, 400)
            return self._json({"ok": True, "voice": name})
        if self.path == "/audio/delete-clone":
            name = slug(body.get("name", ""))
            (VOICES_DIR / f"{name}.wav").unlink(missing_ok=True)
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("AUDIO_PORT", "7802")))
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), H)
    print(f"audio engine on 127.0.0.1:{args.port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()