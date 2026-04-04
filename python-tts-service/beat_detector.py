"""
Beat Detector v4 — port 5051

FIXED emotion detection (v4):
  - Onset SHARPNESS as primary signal (peak-to-mean ratio, not just mean)
  - Energy VARIANCE for triumphant detection (rising energy)
  - Much tighter romantic/neutral thresholds to prevent over-classification
  - Proper hype detection: high RMS + high onset sharpness + BPM > 125

Emotion classes:
  hype        — high RMS + sharp onsets + BPM > 125 → zoom punch, hard cuts
  triumphant  — rising energy + BPM 100-130 + bright spectrum → lens flare, epic zoom
  sad         — low energy + smooth onsets + BPM < 90 → dissolve, desaturate
  romantic    — medium energy + very smooth onsets + BPM 80-115 → soft crossfade, glow
  neutral     — default fallback → standard cut

Returns:
  - drops, beats, bpm, duration, energy_curve  (unchanged)
  - drop_emotions:    emotion label for each drop
  - segment_emotions: emotion label per scene segment
  - segment_features: raw audio features per segment (now includes onset_sharpness, energy_var)
  - emotion_meta:     color/icon/label for each emotion class
"""

import os
import numpy as np
from collections import Counter
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# ── Emotion palette ──────────────────────────────────────────────────────────
EMOTION_META = {
    "hype":       {"color": "#ef4444", "icon": "⚡", "label": "Hype / Action"},
    "triumphant": {"color": "#f59e0b", "icon": "🏆", "label": "Triumphant / Epic"},
    "sad":        {"color": "#3b82f6", "icon": "💙", "label": "Sad / Melancholic"},
    "romantic":   {"color": "#ec4899", "icon": "💗", "label": "Romantic / Hopeful"},
    "neutral":    {"color": "#8b5cf6", "icon": "✦",  "label": "Neutral"},
}


def compute_onset_sharpness(onset_segment):
    """
    Onset sharpness = how "spiky" the onset envelope is.
    High sharpness = sharp transients (drums, percussive hits).
    Low sharpness = smooth sustained sounds (strings, pads, vocals).

    Computed as: (peak / mean) normalized to 0-1 range.
    A perfectly flat signal has sharpness ~1.0 (low).
    A signal with sharp spikes has sharpness >> 1 (high).
    """
    if len(onset_segment) < 2:
        return 0.5
    mean_val = float(np.mean(onset_segment))
    peak_val = float(np.max(onset_segment))
    if mean_val < 1e-9:
        return 0.0
    # peak/mean ratio, clamped to 0-1 via sigmoid-like mapping
    ratio = peak_val / mean_val
    # ratio ~1 = flat (smooth), ratio ~3+ = sharp (percussive)
    # Map: ratio 1→0.1, ratio 2→0.5, ratio 3→0.75, ratio 5+→0.95
    sharpness = 1.0 - 1.0 / (1.0 + 0.5 * (ratio - 1.0))
    return round(min(1.0, max(0.0, sharpness)), 3)


def compute_energy_trend(rms_segment):
    """
    Energy trend: is energy rising, falling, or flat within this segment?
    Returns a value from -1 (falling) to +1 (rising). 0 = flat.
    """
    if len(rms_segment) < 4:
        return 0.0
    n = len(rms_segment)
    first_half = float(np.mean(rms_segment[:n // 2]))
    second_half = float(np.mean(rms_segment[n // 2:]))
    total_mean = float(np.mean(rms_segment))
    if total_mean < 1e-9:
        return 0.0
    trend = (second_half - first_half) / (total_mean + 1e-9)
    return round(min(1.0, max(-1.0, trend)), 3)


def classify_emotion(local_bpm, energy, centroid, onset_mean, onset_sharpness, energy_trend):
    """
    Rule-based classifier v4: map audio features → emotion label.

    Primary signal: onset_sharpness (how percussive the segment is)
    Secondary signals: energy (RMS), BPM, centroid (brightness), energy_trend

    Decision tree (evaluated in order, first match wins):
    """

    # ── HYPE: fast + loud + percussive ────────────────────────────────────
    # Primary: onset sharpness > 0.45 (percussive hits present)
    # Support: high energy + fast BPM
    if onset_sharpness > 0.45 and energy > 0.55 and local_bpm > 125:
        return "hype"

    # Also hype if extremely energetic regardless of BPM
    if energy > 0.75 and onset_sharpness > 0.40:
        return "hype"

    # Also hype at moderate BPM if onsets are very sharp (breakdowns, drops)
    if onset_sharpness > 0.55 and energy > 0.50 and local_bpm > 110:
        return "hype"

    # ── TRIUMPHANT: building energy + bright + moderate tempo ─────────────
    # Primary: rising energy trend
    # Support: bright spectrum (high centroid) + moderate-fast BPM
    if energy_trend > 0.15 and centroid > 0.50 and 100 <= local_bpm <= 145:
        return "triumphant"

    # Also triumphant if high energy + bright but not percussive enough for hype
    if energy > 0.55 and centroid > 0.55 and 100 <= local_bpm <= 145 and onset_sharpness <= 0.45:
        return "triumphant"

    # ── SAD: slow + quiet + smooth ────────────────────────────────────────
    # Primary: low energy
    # Support: slow BPM + smooth onsets
    if energy < 0.30 and local_bpm < 95 and onset_sharpness < 0.30:
        return "sad"

    # Also sad if very low energy regardless of tempo
    if energy < 0.20 and onset_sharpness < 0.35:
        return "sad"

    # Also sad if slow + quiet with falling energy
    if local_bpm < 90 and energy < 0.40 and energy_trend < -0.1:
        return "sad"

    # ── ROMANTIC: medium energy + very smooth onsets + not too fast ───────
    # Primary: smooth onsets (low sharpness) — this is what separates romantic from neutral
    # Support: moderate energy + moderate BPM
    # IMPORTANT: much tighter than v3 to prevent over-classification
    if onset_sharpness < 0.25 and 0.20 <= energy <= 0.50 and local_bpm < 115:
        return "romantic"

    # Also romantic if smooth + moderate with slightly higher energy
    if onset_sharpness < 0.20 and energy <= 0.55 and 75 <= local_bpm <= 120:
        return "romantic"

    # ── NEUTRAL: everything else ──────────────────────────────────────────
    return "neutral"


def analyze(audio_path: str, sensitivity: float = 0.5) -> dict:
    import librosa

    y, sr = librosa.load(audio_path, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    # All beats
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    bpm = float(tempo) if np.isscalar(tempo) else float(tempo[0])

    # Audio feature arrays
    hop_length = 512
    onset_env     = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    onset_times   = librosa.frames_to_time(np.arange(len(onset_env)), sr=sr, hop_length=hop_length)
    rms           = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop_length)[0]
    spec_centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop_length)[0]

    min_len       = min(len(onset_env), len(rms), len(spec_centroid))
    onset_env     = onset_env[:min_len]
    rms           = rms[:min_len]
    spec_centroid = spec_centroid[:min_len]
    onset_times   = onset_times[:min_len]

    onset_norm    = onset_env    / (onset_env.max()    + 1e-9)
    rms_norm      = rms          / (rms.max()          + 1e-9)
    centroid_norm = spec_centroid / (spec_centroid.max() + 1e-9)

    combined = 0.6 * onset_norm + 0.4 * rms_norm

    # Drop detection (same logic as v2/v3)
    threshold      = combined.mean() + (1.5 - sensitivity) * combined.std()
    beats_per_sec  = bpm / 60.0
    min_gap_sec    = max(0.5, 2.0 / beats_per_sec)
    min_gap_frames = int(min_gap_sec * sr / hop_length)

    drop_frames, last_peak = [], -min_gap_frames
    for i in range(1, len(combined) - 1):
        if (combined[i] > threshold and
                combined[i] >= combined[i - 1] and
                combined[i] >= combined[i + 1] and
                i - last_peak >= min_gap_frames):
            drop_frames.append(i)
            last_peak = i

    drop_times     = [float(onset_times[f]) for f in drop_frames]
    drop_strengths = [float(combined[f])    for f in drop_frames]
    max_s          = max(drop_strengths) if drop_strengths else 1.0
    drop_strengths = [round(s / max_s, 3) for s in drop_strengths]

    beat_strengths = []
    for bf in beat_frames:
        idx = min(int(bf * len(combined) / (len(beat_frames) + 1)), len(combined) - 1)
        beat_strengths.append(float(combined[idx]))
    max_bs = max(beat_strengths) if beat_strengths else 1.0
    beat_strengths = [round(s / max_bs, 3) for s in beat_strengths]

    # ── Per-segment emotion classification ────────────────────────────────
    # Segments: [0→drop0], [drop0→drop1], ..., [dropN→end]
    boundaries = [0.0] + drop_times + [duration]
    segment_emotions, segment_features = [], []

    for i in range(len(boundaries) - 1):
        seg_start   = boundaries[i]
        seg_end     = boundaries[i + 1]
        sf          = max(0, min(int(seg_start * sr / hop_length), min_len - 1))
        ef          = max(sf + 1, min(int(seg_end * sr / hop_length), min_len))

        seg_rms_raw   = rms_norm[sf:ef]
        seg_onset_raw = onset_norm[sf:ef]
        seg_cent_raw  = centroid_norm[sf:ef]

        seg_rms      = float(seg_rms_raw.mean())
        seg_centroid = float(seg_cent_raw.mean())
        seg_onset    = float(seg_onset_raw.mean())

        # NEW v4: compute onset sharpness (peak-to-mean ratio)
        seg_onset_sharpness = compute_onset_sharpness(onset_env[sf:ef])

        # NEW v4: compute energy trend (rising/falling)
        seg_energy_trend = compute_energy_trend(rms[sf:ef])

        beats_in_seg = [t for t in beat_times if seg_start <= t < seg_end]
        seg_dur      = seg_end - seg_start
        local_bpm    = (len(beats_in_seg) / seg_dur * 60.0) if len(beats_in_seg) >= 2 else bpm

        emotion = classify_emotion(
            local_bpm, seg_rms, seg_centroid, seg_onset,
            seg_onset_sharpness, seg_energy_trend,
        )
        segment_emotions.append(emotion)
        segment_features.append({
            "bpm":              round(local_bpm, 1),
            "energy":           round(seg_rms, 3),
            "centroid":         round(seg_centroid, 3),
            "onset":            round(seg_onset, 3),
            "onset_sharpness":  seg_onset_sharpness,
            "energy_trend":     seg_energy_trend,
        })

    # drop_emotions[i] = emotion of the scene that STARTS at drop i
    # segment_emotions[0] = intro scene (before drop 0)
    # segment_emotions[i+1] = scene starting at drop i
    drop_emotions = [
        segment_emotions[min(i + 1, len(segment_emotions) - 1)]
        for i in range(len(drop_times))
    ]

    # Energy curve (50 points) for waveform
    step   = max(1, len(rms_norm) // 50)
    energy = [round(float(rms_norm[i]), 3) for i in range(0, len(rms_norm), step)][:50]

    # Log emotion distribution
    emo_dist = Counter(segment_emotions)
    print(f"   🎭 Emotion breakdown: {dict(emo_dist)}")
    for seg_i, (feat, emo) in enumerate(zip(segment_features, segment_emotions)):
        print(f"      seg {seg_i}: {emo:12s}  bpm={feat['bpm']:5.1f}  "
              f"energy={feat['energy']:.2f}  sharpness={feat['onset_sharpness']:.2f}  "
              f"trend={feat['energy_trend']:+.2f}  centroid={feat['centroid']:.2f}")

    return {
        "bpm":              round(bpm, 1),
        "duration":         round(duration, 2),
        "beats":            [round(t, 3) for t in beat_times],
        "beat_strengths":   beat_strengths,
        "beat_count":       len(beat_times),
        "drops":            [round(t, 3) for t in drop_times],
        "drop_strengths":   drop_strengths,
        "drop_count":       len(drop_times),
        "drop_emotions":    drop_emotions,
        "segment_emotions": segment_emotions,
        "segment_features": segment_features,
        "emotion_meta":     EMOTION_META,
        "energy_curve":     energy,
        "threshold_used":   round(float(threshold), 3),
    }


@app.route("/health", methods=["GET"])
def health():
    try:
        import librosa  # noqa
        return jsonify({"status": "ok", "librosa": True})
    except ImportError:
        return jsonify({"status": "ok", "librosa": False,
                        "hint": "pip3 install librosa numpy"}), 200


@app.route("/analyze", methods=["POST"])
def analyze_route():
    data        = request.get_json(force=True, silent=True) or {}
    audio_path  = data.get("audio_path", "").strip()
    sensitivity = float(data.get("sensitivity", 0.5))

    if not audio_path or not os.path.exists(audio_path):
        return jsonify({"error": f"audio_path not found: {audio_path!r}"}), 400

    try:
        result = analyze(audio_path, sensitivity)
        emo_dist = Counter(result["segment_emotions"])
        print(f"✅ {os.path.basename(audio_path)}: {result['bpm']} BPM, "
              f"{result['beat_count']} beats, {result['drop_count']} drops — "
              f"emotions: {dict(emo_dist)}")
        return jsonify(result)
    except ImportError:
        return jsonify({"error": "librosa not installed",
                        "hint": "pip3 install librosa numpy"}), 500
    except Exception as e:
        import traceback
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500


# ── VISUAL FEATURE EXTRACTION ────────────────────────────────────────────────

@app.route("/extract-visual", methods=["POST"])
def extract_visual_route():
    """Extract visual features from a single image."""
    data = request.get_json(force=True, silent=True) or {}
    image_path = data.get("image_path", "").strip()

    if not image_path or not os.path.exists(image_path):
        return jsonify({"error": f"image_path not found: {image_path!r}"}), 400

    try:
        from visual_features import extract_features
        features = extract_features(image_path)
        if features is None:
            return jsonify({"error": "Could not read image"}), 400
        return jsonify({"success": True, "features": features})
    except ImportError as e:
        return jsonify({"error": f"Missing dependency: {e}",
                        "hint": "pip3 install Pillow opencv-python"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/extract-visual-batch", methods=["POST"])
def extract_visual_batch_route():
    """Extract visual features from multiple images in one call."""
    data = request.get_json(force=True, silent=True) or {}
    image_paths = data.get("image_paths", [])

    if not image_paths:
        return jsonify({"error": "No image_paths provided"}), 400

    try:
        from visual_features import extract_features
        results = []
        for path in image_paths:
            if os.path.exists(path):
                features = extract_features(path)
                results.append({"path": path, "features": features})
            else:
                results.append({"path": path, "features": None, "error": "not found"})
        print(f"   👁  Visual features extracted for {len([r for r in results if r['features']])} / {len(image_paths)} images")
        return jsonify({"success": True, "results": results})
    except ImportError as e:
        return jsonify({"error": f"Missing dependency: {e}",
                        "hint": "pip3 install Pillow opencv-python"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("BEAT_PORT", 5051))
    print(f"🎵 Beat Detector v4 running on http://localhost:{port}")
    print(f"   Emotion detection: onset sharpness as primary signal")
    print(f"   Visual features: /extract-visual, /extract-visual-batch")
    print(f"   Classes: hype / triumphant / sad / romantic / neutral")
    app.run(host="0.0.0.0", port=port, debug=False)
