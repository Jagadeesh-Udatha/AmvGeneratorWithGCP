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
    Rule-based classifier v5: map audio features → emotion label.

    v5 changes over v4:
      - SAD thresholds broadened: captures more slow/melodic segments correctly.
        Previously only fired at energy < 0.30 + bpm < 95; now fires up to
        energy < 0.50 + bpm < 100 when onsets are smooth.
      - ROMANTIC tightened slightly: requires onset_sharpness < 0.30 (was 0.25)
        to avoid misclassifying slow neutral segments as romantic.
      - NEUTRAL is now truly the last resort — every slow, melodic, quiet
        segment should be sad or romantic, not neutral.

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

    # ── SAD: slow + relatively quiet + smooth onsets ──────────────────────
    # v5: broadened. A sad/emotional ballad at 100 BPM with medium energy
    # (like many J-pop / anime OSTs) was previously classified as neutral.
    # Now captures any segment that is slow AND not percussive AND not bright.

    # Primary: low energy + slow BPM + smooth onsets
    if energy < 0.30 and local_bpm < 95 and onset_sharpness < 0.30:
        return "sad"

    # Also sad if very low energy regardless of tempo
    if energy < 0.20 and onset_sharpness < 0.35:
        return "sad"

    # Also sad if slow + quiet with falling energy
    if local_bpm < 90 and energy < 0.40 and energy_trend < -0.1:
        return "sad"

    # NEW v5: Slow + moderate energy + smooth onsets → sad (ballad/emotional)
    # This catches anime ballads at 90-105 BPM with mid-level energy.
    if local_bpm < 105 and energy < 0.50 and onset_sharpness < 0.35 and centroid < 0.50:
        return "sad"

    # NEW v5: Falling energy on a slow-ish song = emotional/sad outro
    if energy_trend < -0.20 and local_bpm < 115 and energy < 0.55:
        return "sad"

    # ── ROMANTIC: medium energy + smooth onsets + not too fast ────────────
    # v5: slightly broader sharpness threshold (was < 0.25, now < 0.30)
    # to catch more melodic/gentle sections that aren't quite sad.
    if onset_sharpness < 0.30 and 0.20 <= energy <= 0.55 and local_bpm < 115:
        return "romantic"

    # Also romantic if smooth + moderate with slightly higher energy
    if onset_sharpness < 0.22 and energy <= 0.60 and 75 <= local_bpm <= 120:
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
    # Guard: librosa returns bpm=0.0 on silence or very short audio.
    # Clamp to minimum 60 BPM so beats_per_sec is never 0 (avoids ZeroDivisionError).
    safe_bpm       = max(60.0, bpm)
    beats_per_sec  = safe_bpm / 60.0
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
        # Guard: seg_dur must be > 0 and beats >= 2 for a reliable local BPM.
        # Fall back to global bpm when segment is too short or has too few beats.
        if len(beats_in_seg) >= 2 and seg_dur > 0.1:
            local_bpm = len(beats_in_seg) / seg_dur * 60.0
        else:
            local_bpm = safe_bpm  # use the already-clamped global BPM

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
    """Extract visual features (including expression) from multiple images."""
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


@app.route("/expression-sort", methods=["POST"])
def expression_sort_route():
    """
    Analyze expressions in images and return sorted order to match an emotion arc.

    Input:
        {
          "image_paths": ["/path/to/img1.jpg", ...],
          "emotion_arc": ["hype", "sad", "neutral", ...]   // from audio analysis
        }

    Output:
        {
          "success": true,
          "sorted_paths": [...],          // paths reordered to match emotion arc
          "expression_map": {             // what expression was detected per image
            "/path/img1.jpg": {
              "expression": "happy",
              "scores": {...},
              "face_detected": true
            }
          }
        }

    HOW MATCHING WORKS:
        Expression → compatible music emotions:
          happy      → hype, triumphant          (energy, celebration)
          angry      → hype                      (battle, intensity)
          surprised  → hype, triumphant          (shock, impact)
          sad        → sad, romantic              (melancholy)
          calm       → romantic, neutral, smooth  (peaceful)
          no_face    → neutral (scored by scene)

        For each position in the emotion_arc, the best-matching unused image is chosen.
        "Best match" = highest compatibility score between image expression and target emotion.
    """
    data = request.get_json(force=True, silent=True) or {}
    image_paths = data.get("image_paths", [])
    emotion_arc = data.get("emotion_arc", [])

    if not image_paths:
        return jsonify({"error": "No image_paths provided"}), 400

    try:
        from visual_features import detect_expression
    except ImportError as e:
        return jsonify({"error": f"Missing dependency: {e}"}), 500

    # Expression → music emotion compatibility matrix
    # Rows = detected expressions, Cols = target music emotions
    # Score 0.0-1.0: how well this expression fits that music emotion
    COMPAT = {
        #                hype  triumphant  sad  romantic  neutral
        "happy":     {"hype": 0.8, "triumphant": 1.0, "sad": 0.0, "romantic": 0.4, "neutral": 0.3},
        "angry":     {"hype": 1.0, "triumphant": 0.5, "sad": 0.2, "romantic": 0.0, "neutral": 0.2},
        "surprised": {"hype": 0.9, "triumphant": 0.7, "sad": 0.1, "romantic": 0.1, "neutral": 0.3},
        "sad":       {"hype": 0.0, "triumphant": 0.1, "sad": 1.0, "romantic": 0.8, "neutral": 0.4},
        "calm":      {"hype": 0.1, "triumphant": 0.3, "sad": 0.5, "romantic": 0.9, "neutral": 1.0},
        "no_face":   {"hype": 0.5, "triumphant": 0.5, "sad": 0.5, "romantic": 0.5, "neutral": 0.8},
    }

    # Analyze all images
    expression_map = {}
    for path in image_paths:
        if os.path.exists(path):
            result = detect_expression(path)
            expression_map[path] = result
            expr = result["dominant_expression"]
            conf = result["confidence"]
            face = "✓ face" if result["face_detected"] else "no face"
            print(f"   🎭 {os.path.basename(path)}: {expr} ({conf:.2f}) [{face}]")
        else:
            expression_map[path] = {"dominant_expression": "calm", "scores": {}, "face_detected": False, "confidence": 0.0}

    # If no emotion arc, sort by energy (hype first → sad last)
    if not emotion_arc:
        emotion_arc = ["hype"] * len(image_paths)

    def compat_score(path, target_emotion):
        """Compatibility score between image expression and target music emotion."""
        expr_result = expression_map.get(path, {})
        expr = expr_result.get("dominant_expression", "calm")
        conf = expr_result.get("confidence", 0.5)
        scores = expr_result.get("scores", {})

        # Primary: use compatibility matrix
        base_compat = COMPAT.get(expr, COMPAT["calm"]).get(target_emotion, 0.5)

        # Secondary: use weighted sum across all detected expression scores
        weighted = 0.0
        for detected_expr, expr_score in scores.items():
            weighted += expr_score * COMPAT.get(detected_expr, COMPAT["calm"]).get(target_emotion, 0.5)

        # Blend: 60% primary, 40% weighted (handles uncertain detections better)
        final = 0.60 * base_compat + 0.40 * weighted

        # Boost if expression was detected with high confidence and face was found
        if expr_result.get("face_detected") and conf > 0.5:
            final = min(1.0, final * 1.15)

        return final

    # Greedy assignment: for each arc position, pick best unused image
    used   = set()
    sorted_paths = []

    for target_emotion in emotion_arc:
        best_path  = None
        best_score = -1.0
        for path in image_paths:
            if path in used:
                continue
            score = compat_score(path, target_emotion)
            if score > best_score:
                best_score = score
                best_path  = path
        if best_path:
            used.add(best_path)
            sorted_paths.append(best_path)

    # Append any images not yet assigned (more images than arc positions)
    for path in image_paths:
        if path not in used:
            sorted_paths.append(path)

    print(f"   ✅ Expression sort: {len(sorted_paths)} images ordered for {len(set(emotion_arc))} emotion types")

    return jsonify({
        "success": True,
        "sorted_paths": sorted_paths,
        "original_paths": image_paths,
        "expression_map": {
            path: {
                "expression": expression_map[path].get("dominant_expression", "calm"),
                "face_detected": expression_map[path].get("face_detected", False),
                "confidence": expression_map[path].get("confidence", 0.0),
                "scores": expression_map[path].get("scores", {}),
                "face_bbox": expression_map[path].get("face_bbox", None),
            }
            for path in image_paths
        }
    })

# ── BACKGROUND REMOVAL ───────────────────────────────────────────────────────

@app.route("/remove-bg", methods=["POST"])
def remove_bg_route():
    """
    Remove the background from an uploaded image using rembg.

    Accepts:
      multipart/form-data  with field "file"   (file upload)
      application/json     with field "image_path"  (server-side path)

    Returns:
      On success: PNG file with transparent background (RGBA).
      On rembg-not-installed: 501 with install hint.
      On failure: fallback response pointing to original image.
    """
    import tempfile, uuid, os

    try:
        from visual_features import remove_background, HAS_REMBG
    except ImportError:
        return jsonify({"error": "visual_features module not found"}), 500

    if not HAS_REMBG:
        return jsonify({
            "error":   "rembg not installed",
            "hint":    "pip install rembg onnxruntime",
            "success": False,
        }), 501

    # ── Resolve input path ───────────────────────────────────────────────────
    image_path = None
    tmp_upload = None

    if request.content_type and "multipart" in request.content_type:
        # File upload
        file_obj = request.files.get("file")
        if not file_obj:
            return jsonify({"error": "No file field in multipart request"}), 400

        ext       = os.path.splitext(file_obj.filename or "upload.jpg")[1] or ".jpg"
        tmp_upload = os.path.join(tempfile.gettempdir(), f"rmbg_in_{uuid.uuid4().hex[:8]}{ext}")
        file_obj.save(tmp_upload)
        image_path = tmp_upload
    else:
        data = request.get_json(force=True, silent=True) or {}
        image_path = data.get("image_path", "").strip()
        if not image_path or not os.path.exists(image_path):
            return jsonify({"error": f"image_path not found: {image_path!r}"}), 400

    # ── Remove background ────────────────────────────────────────────────────
    out_path = None
    try:
        out_path = os.path.join(
            tempfile.gettempdir(),
            f"rmbg_out_{uuid.uuid4().hex[:8]}.png",
        )
        result_path = remove_background(image_path, out_path)

        from flask import send_file
        return send_file(
            result_path,
            mimetype="image/png",
            as_attachment=False,
        )

    except Exception as e:
        print(f"   ⚠️  /remove-bg failed: {e}")
        # Graceful fallback: return original image path so caller can proceed
        return jsonify({
            "success":   False,
            "error":     str(e),
            "fallback":  image_path,  # caller can use original
        }), 200   # 200 so caller can check success flag without exception handling

    finally:
        # Clean up temp upload (not the output — caller downloads it synchronously)
        if tmp_upload and os.path.exists(tmp_upload):
            try:
                os.remove(tmp_upload)
            except Exception:
                pass


if __name__ == "__main__":
    port = int(os.environ.get("BEAT_PORT", 5051))
    print(f"🎵 Beat Detector v4 running on http://localhost:{port}")
    print(f"   Emotion detection: onset sharpness as primary signal")
    print(f"   Visual features: /extract-visual, /extract-visual-batch")
    print(f"   Background removal: /remove-bg (requires rembg + onnxruntime)")
    print(f"   Classes: hype / triumphant / sad / romantic / neutral")

    # ── Startup check: mediapipe for face landmark detection ─────────────────
    import sys
    try:
        import mediapipe
        mp_ok = True
        print(f"   Face landmarks: ✅ mediapipe {mediapipe.__version__} (face-based expression detection)")
    except ImportError:
        mp_ok = False
        print(f"   Face landmarks: ❌ mediapipe NOT installed in this Python ({sys.executable})")
        print(f"")
        print(f"   ⚠️  EXPRESSION DETECTION DEGRADED — all images will return 'calm'")
        print(f"")
        print(f"   FIX (run in a new terminal, then restart this service):")
        print(f"   {sys.executable} -m pip install mediapipe")
        print(f"")
        print(f"   If mediapipe is in a venv, use the venv Python to run this service:")
        print(f"   /path/to/venv/bin/python3 beat_detector.py")

    # Check face_landmarker.task model
    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "face_landmarker.task")
    if os.path.exists(model_path) and os.path.getsize(model_path) > 100000:
        size_mb = os.path.getsize(model_path) / (1024 * 1024)
        print(f"   Landmark model:  ✅ face_landmarker.task ({size_mb:.1f}MB)")
    else:
        print(f"   Landmark model:  ❌ face_landmarker.task not found")
        print(f"   Download: python3 -c \"import urllib.request; urllib.request.urlretrieve('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', 'face_landmarker.task')\"")

    app.run(host="0.0.0.0", port=port, debug=False)