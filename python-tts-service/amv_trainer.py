"""
AMV Edit Classifier Trainer v3
==============================

Stage 6: Visual features + 18-feature model + 4 output targets
Stage 7: External AMV training data + visual transition detection

FEATURES (18):
  Audio (7):  bpm, energy, relative_energy, centroid, onset, beat_alignment, segment_duration
  Visual (8): mean_brightness, saturation, edge_density, dominant_hue,
              color_temperature, face_present, dark_scene, contrast
  Context (3): scene_position, onset_sharpness, energy_trend

TARGETS (4):
  transition   — 25 classes
  effect       — 28 classes
  color_grade  — 12 classes
  stutter_cut  — boolean (0/1)

DATA SOURCES:
  1. Real AMVs (downloaded via yt-dlp) — scene cuts + audio features + visual features
  2. User edits from SQLite database (was_edited=1 scenes)
  3. Synthetic data (for bootstrapping)
  4. CapCut/FCP project files (if available)

Usage:
  python amv_trainer.py --status              # show dataset stats
  python amv_trainer.py --synthetic           # train on synthetic data only
  python amv_trainer.py --collect --urls amv_urls.txt  # download + extract
  python amv_trainer.py --train              # train on all collected data
  python amv_trainer.py --all --urls amv_urls.txt      # collect + train
  python amv_trainer.py --learn-edits        # import user edits from SQLite + retrain
"""

import argparse
import json
import os
import subprocess
import sys
import time
import random
from pathlib import Path
from collections import Counter

import numpy as np

# ─── PATHS ────────────────────────────────────────────────────────────────────

BASE_DIR     = Path(__file__).parent
DATA_DIR     = BASE_DIR / "amv_dataset"
VIDEOS_DIR   = DATA_DIR / "videos"
FEATURES_DIR = DATA_DIR / "features"
FRAMES_DIR   = DATA_DIR / "frames"
MODEL_PATH   = BASE_DIR / "amv_model.json"
DB_PATH      = BASE_DIR.parent / "node-service" / "data" / "anime_edit_studio.db"

for d in [DATA_DIR, VIDEOS_DIR, FEATURES_DIR, FRAMES_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ─── FEATURE SPACE ───────────────────────────────────────────────────────────

AUDIO_FEATURES = ["bpm", "energy", "relative_energy", "centroid", "onset",
                  "beat_alignment", "segment_duration"]

VISUAL_FEATURES = ["mean_brightness", "saturation", "edge_density", "dominant_hue",
                   "color_temperature", "face_present", "dark_scene", "contrast"]

CONTEXT_FEATURES = ["scene_position", "onset_sharpness", "energy_trend"]

ALL_FEATURES = AUDIO_FEATURES + VISUAL_FEATURES + CONTEXT_FEATURES  # 18 total

# ─── LABEL SPACE (v3 — new effects library) ──────────────────────────────────

TRANSITIONS = [
    "flash_white", "flash_black", "strobe_cut", "zoom_blur_in", "zoom_blur_out",
    "cross_zoom", "whip_pan_left", "whip_pan_right", "push_left", "push_right",
    "wipe_down", "slice_left", "slice_right", "dissolve", "dissolve_fast",
    "dissolve_slow", "dissolve_glow", "fadeblack", "fadeblack_fast",
    "fadeblack_slow", "fadewhite", "glitch_cut", "pixelize", "ripple", "film_burn",
]

EFFECTS = [
    "zoom_pulse", "zoom_punch", "zoom_punch_out", "zoom_in", "zoom_out",
    "ken_burns", "ken_burns_fast", "ken_burns_slow", "pan_left", "pan_right",
    "drift_left", "drift_right", "breathe", "breathe_fast", "breathe_slow",
    "shake_horizontal", "shake_vertical", "spin_cw", "spin_ccw", "tilt_shift",
    "glitch_horizontal", "glitch_flash", "vhs_shake", "speed_ramp_in",
    "speed_ramp_out", "freeze_punch", "echo_trail", "static",
]

COLOR_GRADES = [
    "hype_red", "hype_blue", "sad_blue", "sad_grey", "romantic_warm",
    "romantic_soft", "triumphant_gold", "cinematic", "vintage", "neon", "manga", "none",
]

GRADE_BY_ENERGY = {
    "high":   ["hype_red", "hype_blue", "neon", "cinematic"],
    "medium": ["cinematic", "vintage", "triumphant_gold", "none"],
    "low":    ["sad_blue", "sad_grey", "romantic_warm", "romantic_soft", "vintage"],
}

TRANSITION_BY_ENERGY = {
    "high":   ["flash_black", "glitch_cut", "whip_pan_left", "flash_white", "strobe_cut", "film_burn", "slice_left"],
    "medium": ["dissolve", "push_left", "cross_zoom", "zoom_blur_in", "fadeblack", "dissolve_fast", "push_right"],
    "low":    ["dissolve_slow", "dissolve_glow", "fadeblack_slow", "fadewhite", "ripple", "dissolve"],
}

EFFECT_BY_ENERGY = {
    "high":   ["zoom_punch", "shake_horizontal", "glitch_flash", "vhs_shake", "speed_ramp_in", "zoom_pulse", "breathe_fast"],
    "medium": ["ken_burns", "zoom_in", "pan_left", "pan_right", "breathe", "tilt_shift", "drift_right"],
    "low":    ["ken_burns_slow", "breathe_slow", "drift_left", "echo_trail", "zoom_out", "static"],
}


def energy_tier(energy: float) -> str:
    if energy > 0.55: return "high"
    if energy > 0.30: return "medium"
    return "low"


# ─── VISUAL FEATURE EXTRACTION ───────────────────────────────────────────────

def extract_frame(video_path: Path, timestamp: float, out_path: Path) -> bool:
    """Extract a single frame from a video at a given timestamp."""
    cmd = ["ffmpeg", "-ss", str(timestamp), "-i", str(video_path),
           "-vframes", "1", "-q:v", "3", str(out_path), "-y", "-loglevel", "quiet"]
    try:
        subprocess.run(cmd, timeout=10, check=True)
        return out_path.exists()
    except:
        return False


def extract_visual_features(image_path: str) -> dict:
    """Extract visual features from an image. Uses visual_features.py."""
    try:
        from visual_features import extract_features
        features = extract_features(image_path)
        return features or {}
    except ImportError:
        return {}
    except:
        return {}


# ─── TRANSITION DETECTION FROM VIDEO (Stage 7) ───────────────────────────────

def detect_transition_type(video_path: Path, cut_time: float, pre_sec=0.3) -> str:
    """
    Detect what type of transition occurs at a cut point by analyzing
    brightness patterns around the cut.

    Returns: transition name guess based on visual analysis.
    """
    try:
        from PIL import Image
    except ImportError:
        return "dissolve"  # fallback

    # Extract frames: 2 before cut, 2 after
    frames = []
    for offset in [-pre_sec, -0.05, 0.05, pre_sec]:
        t = max(0, cut_time + offset)
        fpath = FRAMES_DIR / f"trans_{t:.3f}.jpg"
        if extract_frame(video_path, t, fpath):
            try:
                img = Image.open(str(fpath)).convert("L")  # grayscale
                img.thumbnail((64, 64))
                brightness = sum(img.getdata()) / (64 * 64 * 255)
                frames.append(brightness)
            except:
                frames.append(0.5)
            try: fpath.unlink()
            except: pass
        else:
            frames.append(0.5)

    if len(frames) < 4:
        return "dissolve"

    pre_avg = (frames[0] + frames[1]) / 2
    post_avg = (frames[2] + frames[3]) / 2
    at_cut = (frames[1] + frames[2]) / 2

    # Flash white: brightness spike > 0.85 at cut
    if at_cut > 0.85:
        return "flash_white"

    # Flash black: brightness dip < 0.1 at cut
    if at_cut < 0.1:
        return "flash_black"

    # Glitch: large brightness difference between consecutive frames
    if abs(frames[1] - frames[2]) > 0.4:
        return "glitch_cut"

    # Dissolve: gradual change
    if abs(pre_avg - post_avg) < 0.15:
        return "dissolve"

    # Wipe: moderate directional change
    if abs(pre_avg - post_avg) > 0.3:
        return "whip_pan_left" if pre_avg > post_avg else "whip_pan_right"

    return "fadeblack"


# ─── AUDIO FEATURES ──────────────────────────────────────────────────────────

def extract_audio(video_path: Path, wav_path: Path):
    cmd = ["ffmpeg", "-i", str(video_path), "-q:a", "0", "-map", "a",
           "-ar", "22050", "-ac", "1", str(wav_path), "-y", "-loglevel", "quiet"]
    subprocess.run(cmd, timeout=120, check=True)


def extract_segment_features(y, sr, start, end, global_beats, global_energy_mean):
    """Extract 7 audio features + 2 context features for a segment."""
    import librosa

    s = int(start * sr)
    e = int(end * sr)
    seg = y[s:e]
    if len(seg) < 512:
        return None

    dur = end - start
    rms = float(np.sqrt(np.mean(seg ** 2)))
    energy = min(1.0, rms * 10)
    rel_energy = min(2.0, energy / (global_energy_mean + 1e-8))

    cent = librosa.feature.spectral_centroid(y=seg, sr=sr)[0]
    centroid = float(np.mean(cent) / (sr / 2))

    onset_env = librosa.onset.onset_strength(y=seg, sr=sr)
    onset = float(np.mean(onset_env) / (np.max(onset_env) + 1e-8))

    # Onset sharpness
    onset_mean = float(np.mean(onset_env))
    onset_peak = float(np.max(onset_env))
    if onset_mean > 1e-9:
        ratio = onset_peak / onset_mean
        onset_sharpness = 1.0 - 1.0 / (1.0 + 0.5 * (ratio - 1.0))
    else:
        onset_sharpness = 0.0

    # Energy trend
    rms_arr = librosa.feature.rms(y=seg, frame_length=2048, hop_length=512)[0]
    if len(rms_arr) >= 4:
        first_half = float(np.mean(rms_arr[:len(rms_arr)//2]))
        second_half = float(np.mean(rms_arr[len(rms_arr)//2:]))
        total_mean = float(np.mean(rms_arr))
        energy_trend = (second_half - first_half) / (total_mean + 1e-9)
        energy_trend = max(-1.0, min(1.0, energy_trend))
    else:
        energy_trend = 0.0

    try:
        tempo, _ = librosa.beat.beat_track(y=seg, sr=sr)
        bpm = float(tempo[0]) if hasattr(tempo, '__len__') else float(tempo)
        bpm = max(40.0, min(220.0, bpm))
    except:
        bpm = 120.0

    if global_beats:
        dists = [abs(start - b) for b in global_beats]
        min_dist = min(dists)
        avg_interval = np.mean(np.diff(global_beats)) if len(global_beats) > 1 else 0.5
        beat_align = min(1.0, min_dist / (avg_interval / 2 + 1e-8))
    else:
        beat_align = 0.5

    return {
        "bpm":              round(bpm, 2),
        "energy":           round(energy, 4),
        "relative_energy":  round(rel_energy, 4),
        "centroid":         round(centroid, 4),
        "onset":            round(onset, 4),
        "beat_alignment":   round(beat_align, 4),
        "segment_duration": round(dur, 3),
        "onset_sharpness":  round(onset_sharpness, 3),
        "energy_trend":     round(energy_trend, 3),
    }


# ─── LABELING (v3 — 4 targets) ───────────────────────────────────────────────

def label_from_context(feats, visual_feats, prev_effect, prev_transition, scene_idx, total_scenes, rng):
    """
    Label a segment with 4 targets based on audio + visual context.
    Uses distributions within energy tiers (not deterministic formulas).
    """
    tier = energy_tier(feats.get("energy", 0.5))
    on_beat = feats.get("beat_alignment", 0.5) < 0.25
    is_dark = visual_feats.get("dark_scene", 0) == 1
    has_face = visual_feats.get("face_present", 0) == 1
    is_warm = visual_feats.get("warm_dominant", 0) == 1
    high_edge = visual_feats.get("edge_density", 0.3) > 0.2
    position = scene_idx / max(1, total_scenes - 1)  # 0-1

    # ── Transition ──
    cand_t = list(TRANSITION_BY_ENERGY[tier])
    if on_beat and tier == "high":
        cand_t = ["flash_black", "glitch_cut", "strobe_cut"] + cand_t
    if prev_transition and prev_transition in cand_t:
        cand_t = [t for t in cand_t if t != prev_transition] + [prev_transition]
    if scene_idx == 0:
        transition = "dissolve"
    elif position > 0.9:
        transition = rng.choice(["dissolve_slow", "fadeblack_slow", "dissolve"])
    else:
        w = [2.0 if i < len(cand_t)//2 else 1.0 for i in range(len(cand_t))]
        transition = rng.choices(cand_t, weights=w, k=1)[0]

    # ── Effect ──
    cand_e = list(EFFECT_BY_ENERGY[tier])
    if is_dark:
        cand_e = ["glitch_flash", "vhs_shake", "glitch_horizontal"] + cand_e
    if has_face:
        cand_e = ["ken_burns", "zoom_in", "breathe_slow", "tilt_shift"] + cand_e
    if prev_effect and prev_effect in cand_e:
        cand_e = [e for e in cand_e if e != prev_effect] + [prev_effect]
    if position < 0.1:
        cand_e = ["ken_burns_slow", "breathe_slow", "drift_right"] + cand_e
    w = [2.0 if i < len(cand_e)//2 else 1.0 for i in range(len(cand_e))]
    effect = rng.choices(cand_e, weights=w, k=1)[0]

    # ── Color Grade (visual-aware) ──
    cand_g = list(GRADE_BY_ENERGY[tier])
    if is_dark:
        cand_g = ["cinematic", "sad_blue", "hype_blue"] + cand_g
    if is_warm:
        cand_g = ["romantic_warm", "triumphant_gold", "vintage"] + cand_g
    grade = rng.choice(cand_g[:4])  # pick from top candidates

    # ── Stutter Cut ──
    stutter = 0
    if tier == "high" and on_beat and feats.get("segment_duration", 1) < 0.8:
        stutter = 1 if rng.random() < 0.3 else 0

    return {
        "transition":  transition,
        "effect":      effect,
        "color_grade": grade,
        "stutter_cut": stutter,
    }


# ─── COLLECT FROM VIDEO (with visual features) ──────────────────────────────

def collect_features(video_path: Path) -> list:
    import librosa

    print(f"  🔬 {video_path.name}")
    rng = random.Random(hash(video_path.name))

    wav_path = video_path.with_suffix(".wav")
    try:
        extract_audio(video_path, wav_path)
    except Exception as e:
        print(f"     ✗ Audio extraction: {e}")
        return []

    try:
        y, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    except Exception as e:
        print(f"     ✗ Audio load: {e}")
        if wav_path.exists(): wav_path.unlink()
        return []

    total_dur = len(y) / sr

    try:
        _, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        global_beats = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    except:
        global_beats = []

    rms_global = float(np.sqrt(np.mean(y ** 2)))
    global_energy_mean = min(1.0, rms_global * 10)

    # Scene cuts
    cuts = extract_scene_cuts(video_path)
    print(f"     {len(cuts)} cuts, {total_dur:.1f}s, {len(global_beats)} beats")

    if not cuts:
        if global_beats:
            cuts = global_beats[::4]
        else:
            cuts = list(np.arange(2.0, total_dur, 2.5))

    boundaries = [0.0] + cuts + [total_dur]
    samples = []
    prev_effect = None
    prev_transition = None

    for i in range(len(boundaries) - 1):
        start, end = boundaries[i], boundaries[i + 1]
        dur = end - start
        if dur < 0.2 or dur > 25:
            continue

        feats = extract_segment_features(y, sr, start, end, global_beats, global_energy_mean)
        if not feats:
            continue

        # Extract visual features from a frame at midpoint
        mid_time = (start + end) / 2
        frame_path = FRAMES_DIR / f"{video_path.stem}_{mid_time:.2f}.jpg"
        visual_feats = {}
        if extract_frame(video_path, mid_time, frame_path):
            visual_feats = extract_visual_features(str(frame_path))
            try: frame_path.unlink()
            except: pass

        # Detect transition type from video
        if i > 0:
            detected_transition = detect_transition_type(video_path, start)
        else:
            detected_transition = "dissolve"

        # Build label
        position = i / max(1, len(boundaries) - 2)
        label = label_from_context(
            feats, visual_feats, prev_effect, prev_transition,
            i, len(boundaries) - 1, rng
        )
        # Override transition with detected one (more accurate from real video)
        label["transition"] = detected_transition

        prev_effect = label["effect"]
        prev_transition = label["transition"]

        sample = {
            **feats,
            **{k: visual_feats.get(k, 0) for k in VISUAL_FEATURES},
            "scene_position": round(position, 3),
            **label,
            "source": video_path.name,
        }
        samples.append(sample)

    if wav_path.exists():
        wav_path.unlink()

    print(f"     ✓ {len(samples)} samples (with visual features)")
    return samples


def extract_scene_cuts(video_path: Path, threshold: float = 0.3) -> list:
    cmd = ["ffmpeg", "-i", str(video_path),
           "-vf", f"select=gt(scene\\,{threshold}),showinfo",
           "-an", "-f", "null", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        cuts = []
        for line in r.stderr.split("\n"):
            if "pts_time:" in line:
                try:
                    t = float(line.split("pts_time:")[1].split(" ")[0])
                    cuts.append(t)
                except: pass
        return sorted(set(cuts))
    except:
        return []


# ─── USER EDIT IMPORT (Stage 6) ──────────────────────────────────────────────

def import_user_edits() -> list:
    """Import user-edited scenes from SQLite database as training samples."""
    if not DB_PATH.exists():
        print("  ⚠️  Database not found:", DB_PATH)
        return []

    try:
        import sqlite3
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        cursor.execute("""
            SELECT s.*, se.bpm as session_bpm
            FROM scenes s
            JOIN sessions se ON se.id = s.session_id
            WHERE s.was_edited = 1
            AND s.final_effect IS NOT NULL
        """)

        rows = cursor.fetchall()
        conn.close()

        samples = []
        for row in rows:
            sample = {
                # Audio features
                "bpm":              row["segment_bpm"] or row["session_bpm"] or 120,
                "energy":           row["energy"] or 0.5,
                "relative_energy":  1.0,
                "centroid":         row["centroid"] or 0.5,
                "onset":            row["onset"] or 0.5,
                "beat_alignment":   row["beat_alignment"] or 0.5,
                "segment_duration": row["duration"] or 1.0,
                # Visual features
                "mean_brightness":    row["mean_brightness"] or 0.5,
                "saturation":         row["saturation"] or 0.5,
                "edge_density":       row["edge_density"] or 0.3,
                "dominant_hue":       (row["dominant_hue"] or 180) / 360.0,  # normalize to 0-1
                "color_temperature":  row["color_temperature"] or 0.5,
                "face_present":       row["face_present"] or 0,
                "dark_scene":         row["dark_scene"] or 0,
                "contrast":           row["contrast"] or 0.2,
                # Context
                "scene_position":     row["scene_index"] / 20.0,  # approximate
                "onset_sharpness":    0.5,  # not stored yet
                "energy_trend":       0.0,
                # Labels (what the USER chose, not what the AI suggested)
                "transition":  row["final_transition"] or "dissolve",
                "effect":      row["final_effect"] or "ken_burns",
                "color_grade": row["final_color_grade"] or "none",
                "stutter_cut": row["is_stutter_cut"] or 0,
                "source":      "user_edit",
            }
            samples.append(sample)

        print(f"  📝 Imported {len(samples)} user-edited scenes from database")
        return samples

    except ImportError:
        print("  ⚠️  sqlite3 not available")
        return []
    except Exception as e:
        print(f"  ❌ Error reading database: {e}")
        return []


# ─── CAPCUT/FCP PROJECT FILE IMPORT (Stage 7) ────────────────────────────────

def import_capcut_project(project_path: str) -> list:
    """Import scene edits from a CapCut draft.json project file."""
    try:
        with open(project_path) as f:
            project = json.load(f)

        samples = []
        tracks = project.get("tracks", [])
        for track in tracks:
            segments = track.get("segments", [])
            for i, seg in enumerate(segments):
                duration = (seg.get("target_timerange", {}).get("duration", 1000000)) / 1000000
                effect_name = seg.get("extra_material_refs", [""])[0] if seg.get("extra_material_refs") else ""

                sample = {
                    "bpm": 120, "energy": 0.5, "relative_energy": 1.0,
                    "centroid": 0.5, "onset": 0.5, "beat_alignment": 0.5,
                    "segment_duration": duration,
                    "mean_brightness": 0.5, "saturation": 0.5, "edge_density": 0.3,
                    "dominant_hue": 0.5, "color_temperature": 0.5,
                    "face_present": 0, "dark_scene": 0, "contrast": 0.2,
                    "scene_position": i / max(1, len(segments) - 1),
                    "onset_sharpness": 0.5, "energy_trend": 0.0,
                    "transition": "dissolve", "effect": "ken_burns",
                    "color_grade": "none", "stutter_cut": 0,
                    "source": "capcut",
                }
                samples.append(sample)

        print(f"  📦 Imported {len(samples)} segments from CapCut project")
        return samples
    except Exception as e:
        print(f"  ❌ CapCut import failed: {e}")
        return []


def import_fcp_xml(xml_path: str) -> list:
    """Import scene edits from Final Cut Pro XML."""
    try:
        import xml.etree.ElementTree as ET
        tree = ET.parse(xml_path)
        root = tree.getroot()

        samples = []
        for clip in root.iter("clip"):
            duration = float(clip.get("duration", "1").replace("s", ""))
            start = float(clip.get("start", "0").replace("s", ""))

            sample = {
                "bpm": 120, "energy": 0.5, "relative_energy": 1.0,
                "centroid": 0.5, "onset": 0.5, "beat_alignment": 0.5,
                "segment_duration": duration,
                "mean_brightness": 0.5, "saturation": 0.5, "edge_density": 0.3,
                "dominant_hue": 0.5, "color_temperature": 0.5,
                "face_present": 0, "dark_scene": 0, "contrast": 0.2,
                "scene_position": 0.5,
                "onset_sharpness": 0.5, "energy_trend": 0.0,
                "transition": "dissolve", "effect": "ken_burns",
                "color_grade": "none", "stutter_cut": 0,
                "source": "fcp",
            }
            samples.append(sample)

        print(f"  📦 Imported {len(samples)} clips from FCP XML")
        return samples
    except Exception as e:
        print(f"  ❌ FCP import failed: {e}")
        return []


# ─── SYNTHETIC DATA (v3 — visual-aware) ──────────────────────────────────────

def generate_synthetic_samples(n: int = 5000) -> list:
    """Generate synthetic samples with audio + visual + context features."""
    print(f"  🔧 Generating {n} synthetic samples (v3 — visual-aware)...")
    rng_np = np.random.default_rng(42)
    rng = random.Random(42)

    samples = []
    prev_effect = None
    prev_transition = None

    section_patterns = [
        # (energy_mean, std, bpm, dur_mean, brightness, saturation, edge, dark)
        (0.20, 0.06,  80, 4.0, 0.3, 0.3, 0.1, 1),  # dark slow intro
        (0.35, 0.10,  95, 3.0, 0.5, 0.5, 0.2, 0),  # gentle verse
        (0.50, 0.10, 110, 2.0, 0.6, 0.6, 0.3, 0),  # building
        (0.70, 0.12, 130, 1.2, 0.5, 0.5, 0.4, 0),  # chorus
        (0.85, 0.08, 145, 0.8, 0.4, 0.4, 0.5, 1),  # heavy drop
        (0.40, 0.10, 100, 2.5, 0.7, 0.7, 0.2, 0),  # breakdown
    ]

    samples_per = n // (len(section_patterns) * 3)
    total_scenes = samples_per * 3

    for energy_mean, estd, bpm_mean, dur_mean, bright, sat, edge, dark in section_patterns:
        for j in range(samples_per * 3):
            energy   = float(np.clip(rng_np.normal(energy_mean, estd), 0.05, 0.95))
            bpm      = float(np.clip(rng_np.normal(bpm_mean, 15), 50, 200))
            centroid = float(np.clip(0.3 + energy * 0.4 + rng_np.normal(0, 0.05), 0.1, 0.9))
            onset    = float(np.clip(0.2 + energy * 0.5 + rng_np.normal(0, 0.06), 0.05, 0.95))
            beat_aln = float(np.clip(rng_np.exponential(0.15 if energy > 0.6 else 0.45), 0.0, 1.0))
            dur      = float(np.clip(rng_np.exponential(dur_mean), 0.3, 20.0))
            rel_e    = float(np.clip(energy / (energy_mean + 1e-8), 0.2, 3.0))

            # Visual features (simulated)
            mean_bright = float(np.clip(rng_np.normal(bright, 0.15), 0.05, 0.95))
            saturation  = float(np.clip(rng_np.normal(sat, 0.12), 0.05, 0.95))
            edge_dens   = float(np.clip(rng_np.normal(edge, 0.1), 0.0, 1.0))
            dom_hue     = float(rng_np.uniform(0, 1))
            color_temp  = float(np.clip(rng_np.normal(0.5, 0.15), 0.1, 0.9))
            face_pres   = 1 if rng.random() < 0.3 else 0
            dark_sc     = dark
            contrast_v  = float(np.clip(rng_np.normal(0.2, 0.08), 0.05, 0.5))
            position    = j / max(1, total_scenes - 1)

            onset_sharpness = float(np.clip(onset * 0.8 + rng_np.normal(0, 0.1), 0, 1))
            energy_trend    = float(np.clip(rng_np.normal(0, 0.3), -1, 1))

            feats = {
                "bpm": round(bpm, 2), "energy": round(energy, 4),
                "relative_energy": round(rel_e, 4), "centroid": round(centroid, 4),
                "onset": round(onset, 4), "beat_alignment": round(beat_aln, 4),
                "segment_duration": round(dur, 3),
                "onset_sharpness": round(onset_sharpness, 3),
                "energy_trend": round(energy_trend, 3),
            }

            visual_feats = {
                "mean_brightness": round(mean_bright, 3), "saturation": round(saturation, 3),
                "edge_density": round(edge_dens, 3), "dominant_hue": round(dom_hue, 3),
                "color_temperature": round(color_temp, 3), "face_present": face_pres,
                "dark_scene": dark_sc, "contrast": round(contrast_v, 3),
                "warm_dominant": 1 if dom_hue < 0.17 or dom_hue > 0.83 else 0,
            }

            label = label_from_context(feats, visual_feats, prev_effect, prev_transition,
                                        j, total_scenes, rng)
            prev_effect = label["effect"]
            prev_transition = label["transition"]

            sample = {**feats, **{k: visual_feats[k] for k in VISUAL_FEATURES},
                      "scene_position": round(position, 3), **label, "source": "synthetic"}
            samples.append(sample)

    rng.shuffle(samples)
    print(f"  ✓ {len(samples)} synthetic samples across {len(section_patterns)} sections")
    return samples[:n]


# ─── TRAINING (v3 — 4 targets, 18 features) ──────────────────────────────────

def load_dataset() -> list:
    samples = []
    for p in FEATURES_DIR.glob("*.json"):
        try:
            with open(p) as f:
                data = json.load(f)
            if isinstance(data, list):
                samples.extend(data)
        except: pass
    return samples


def balance_classes(samples, label_key):
    counts = Counter(s.get(label_key, "none") for s in samples)
    if not counts:
        return samples
    max_count = max(counts.values())
    rng = random.Random(42)
    balanced = list(samples)
    for label, count in counts.items():
        if count < max_count:
            subset = [s for s in samples if s.get(label_key, "none") == label]
            if subset:
                balanced.extend(rng.choices(subset, k=max_count - count))
    rng.shuffle(balanced)
    return balanced


def train_model(samples):
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.preprocessing import LabelEncoder
    from sklearn.model_selection import cross_val_score

    if not samples:
        raise ValueError("No samples")

    print(f"\n🧠 Training v3 model on {len(samples)} samples ({len(ALL_FEATURES)} features, 4 targets)...")

    # Ensure all samples have all features
    for s in samples:
        for f in ALL_FEATURES:
            if f not in s:
                s[f] = 0.5 if f != "face_present" and f != "dark_scene" else 0
        # Normalize dominant_hue to 0-1 if it's in 0-360
        if s.get("dominant_hue", 0) > 1.0:
            s["dominant_hue"] = s["dominant_hue"] / 360.0

    # Filter valid labels
    valid_samples = [s for s in samples
                     if s.get("transition") in TRANSITIONS
                     and s.get("effect") in EFFECTS]
    # Also accept samples with legacy labels (map them)
    for s in samples:
        if s not in valid_samples:
            if s.get("effect") and s["effect"] not in EFFECTS:
                s["effect"] = "ken_burns"
            if s.get("transition") and s["transition"] not in TRANSITIONS:
                s["transition"] = "dissolve"
            if s.get("color_grade") and s["color_grade"] not in COLOR_GRADES:
                s["color_grade"] = "none"
            valid_samples.append(s)

    samples = valid_samples
    print(f"   Valid samples: {len(samples)}")

    # Source breakdown
    sources = Counter(s.get("source", "unknown") for s in samples)
    print(f"   Sources: {dict(sources)}")

    # Balance classes
    samples_t = balance_classes(samples, "transition")
    samples_e = balance_classes(samples, "effect")
    samples_g = balance_classes([s for s in samples if s.get("color_grade")], "color_grade")

    X_t = np.array([[s.get(f, 0.5) for f in ALL_FEATURES] for s in samples_t], dtype=np.float32)
    X_e = np.array([[s.get(f, 0.5) for f in ALL_FEATURES] for s in samples_e], dtype=np.float32)
    X_g = np.array([[s.get(f, 0.5) for f in ALL_FEATURES] for s in samples_g], dtype=np.float32) if samples_g else None

    le_t = LabelEncoder()
    le_e = LabelEncoder()
    le_g = LabelEncoder()

    y_t = le_t.fit_transform([s.get("transition", "dissolve") for s in samples_t])
    y_e = le_e.fit_transform([s.get("effect", "ken_burns") for s in samples_e])
    y_g = le_g.fit_transform([s.get("color_grade", "none") for s in samples_g]) if samples_g else None

    # Train classifiers
    params = dict(n_estimators=100, max_depth=5, learning_rate=0.1, subsample=0.8, random_state=42)
    clf_t = GradientBoostingClassifier(**params)
    clf_e = GradientBoostingClassifier(**params)
    clf_g = GradientBoostingClassifier(**params) if X_g is not None and len(X_g) > 50 else None

    print("   Cross-validating...")
    cv_t = cross_val_score(clf_t, X_t, y_t, cv=5, scoring="accuracy")
    cv_e = cross_val_score(clf_e, X_e, y_e, cv=5, scoring="accuracy")
    cv_g_str = "N/A"
    if clf_g is not None:
        cv_g = cross_val_score(clf_g, X_g, y_g, cv=5, scoring="accuracy")
        cv_g_str = f"{cv_g.mean()*100:.1f}% ± {cv_g.std()*100:.1f}%"

    print(f"   Transition CV:  {cv_t.mean()*100:.1f}% ± {cv_t.std()*100:.1f}%")
    print(f"   Effect CV:      {cv_e.mean()*100:.1f}% ± {cv_e.std()*100:.1f}%")
    print(f"   Color Grade CV: {cv_g_str}")

    # Final fit
    clf_t.fit(X_t, y_t)
    clf_e.fit(X_e, y_e)
    if clf_g is not None:
        clf_g.fit(X_g, y_g)

    # Feature importance
    fi_t = dict(zip(ALL_FEATURES, clf_t.feature_importances_.tolist()))
    fi_e = dict(zip(ALL_FEATURES, clf_e.feature_importances_.tolist()))
    print(f"\n   Top transition features: {sorted(fi_t.items(), key=lambda x:-x[1])[:5]}")
    print(f"   Top effect features:     {sorted(fi_e.items(), key=lambda x:-x[1])[:5]}")

    # Build lookup table
    print("\n   Building JS lookup table...")
    lookup = build_lookup_table(clf_t, clf_e, le_t, le_e, clf_g, le_g)

    model = {
        "version":     "3.0",
        "trainedAt":   time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sampleCount": len(samples),
        "features":    ALL_FEATURES,
        "accuracy": {
            "transition":    round(float(cv_t.mean()), 4),
            "effect":        round(float(cv_e.mean()), 4),
            "transition_cv": f"{cv_t.mean()*100:.1f}% ± {cv_t.std()*100:.1f}%",
            "effect_cv":     f"{cv_e.mean()*100:.1f}% ± {cv_e.std()*100:.1f}%",
            "grade_cv":      cv_g_str,
        },
        "importances":        {"transition": fi_t, "effect": fi_e},
        "transitionClasses":  le_t.classes_.tolist(),
        "effectClasses":      le_e.classes_.tolist(),
        "gradeClasses":       le_g.classes_.tolist() if clf_g else COLOR_GRADES,
        "lookupTable":        lookup,
        "sources":            dict(sources),
    }
    return model


def build_lookup_table(clf_t, clf_e, le_t, le_e, clf_g=None, le_g=None):
    """Pre-compute predictions across a grid for fast JS lookup."""
    BPM_VALS      = [70, 90, 110, 125, 140, 160]
    ENERGY_VALS   = [0.15, 0.3, 0.5, 0.65, 0.8]
    BEAT_ALN_VALS = [0.1, 0.4, 0.7]
    DUR_VALS      = [0.5, 1.5, 3.0, 6.0]

    lookup = {}
    for bpm in BPM_VALS:
        for energy in ENERGY_VALS:
            for beat_aln in BEAT_ALN_VALS:
                for dur in DUR_VALS:
                    feat_vec = {
                        "bpm": bpm, "energy": energy, "relative_energy": 1.0,
                        "centroid": 0.3+energy*0.4, "onset": 0.2+energy*0.5,
                        "beat_alignment": beat_aln, "segment_duration": dur,
                        "mean_brightness": 0.5, "saturation": 0.5, "edge_density": 0.3,
                        "dominant_hue": 0.5, "color_temperature": 0.5,
                        "face_present": 0, "dark_scene": 0, "contrast": 0.2,
                        "scene_position": 0.5, "onset_sharpness": energy*0.6,
                        "energy_trend": 0.0,
                    }
                    row = np.array([[feat_vec[f] for f in ALL_FEATURES]], dtype=np.float32)
                    t_idx = clf_t.predict(row)[0]
                    e_idx = clf_e.predict(row)[0]
                    entry = {
                        "transition": le_t.classes_[t_idx],
                        "effect": le_e.classes_[e_idx],
                    }
                    if clf_g is not None:
                        g_idx = clf_g.predict(row)[0]
                        entry["color_grade"] = le_g.classes_[g_idx]

                    key = f"{bpm},{energy},{beat_aln},{dur}"
                    lookup[key] = entry
    return lookup


# ─── DOWNLOAD ─────────────────────────────────────────────────────────────────

def download_amv(url, out_dir):
    print(f"  ⬇  {url[:70]}...")
    safe = url.split("v=")[-1].split("&")[0].replace("/", "_")[:20]
    out_path = out_dir / f"{safe}.mp4"
    if out_path.exists():
        print(f"     ✓ Already downloaded")
        return out_path
    cmd = ["yt-dlp", "--format", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]",
           "--merge-output-format", "mp4", "--output", str(out_path),
           "--no-playlist", "--max-filesize", "200M", "--quiet", url]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=300)
        if out_path.exists():
            print(f"     ✓ {out_path.stat().st_size // 1024 // 1024:.0f} MB")
            return out_path
        print(f"     ✗ {r.stderr.decode()[:100]}")
    except Exception as e:
        print(f"     ✗ {e}")
    return None


# ─── CLI ──────────────────────────────────────────────────────────────────────

def cmd_status():
    samples = load_dataset()
    videos = list(VIDEOS_DIR.glob("*.mp4"))
    feats = list(FEATURES_DIR.glob("*.json"))
    user_edits = import_user_edits()
    print(f"\n📊 AMV Dataset Status (v3)")
    print(f"   Real AMV samples:   {len(samples)}")
    print(f"   Videos downloaded:  {len(videos)}")
    print(f"   Feature files:      {len(feats)}")
    print(f"   User edit samples:  {len(user_edits)}")
    print(f"   Features used:      {len(ALL_FEATURES)} ({len(AUDIO_FEATURES)} audio + {len(VISUAL_FEATURES)} visual + {len(CONTEXT_FEATURES)} context)")
    if MODEL_PATH.exists():
        with open(MODEL_PATH) as f:
            m = json.load(f)
        acc = m.get("accuracy", {})
        print(f"   Model version:      {m.get('version','?')} ({m.get('trainedAt','?')})")
        print(f"   Model samples:      {m.get('sampleCount', '?')}")
        print(f"   Accuracy:           trans={acc.get('transition_cv','?')}  effect={acc.get('effect_cv','?')}  grade={acc.get('grade_cv','?')}")
        print(f"   Sources:            {m.get('sources', {})}")
    else:
        print(f"   Model:              ❌ Not trained yet")


def cmd_collect(urls):
    for url in urls:
        url = url.strip()
        if not url or url.startswith("#"): continue
        vid = download_amv(url, VIDEOS_DIR)
        if not vid: continue
        feat_path = FEATURES_DIR / f"{vid.stem}.json"
        if feat_path.exists():
            print(f"  ✓ Features exist for {vid.stem}")
            continue
        s = collect_features(vid)
        if s:
            with open(feat_path, "w") as f:
                json.dump(s, f, indent=2)
            print(f"  💾 {len(s)} samples → {feat_path.name}")


def cmd_train(synthetic_only=False):
    if synthetic_only:
        samples = generate_synthetic_samples(5000)
    else:
        samples = load_dataset()
        user_edits = import_user_edits()
        # User edits are weighted 3x (they represent explicit preferences)
        samples = samples + user_edits * 3
        if len(samples) < 200:
            print(f"  Only {len(samples)} real samples — supplementing with synthetic")
            samples = samples + generate_synthetic_samples(max(2000, 5000 - len(samples)))

    model = train_model(samples)

    with open(MODEL_PATH, "w") as f:
        json.dump(model, f, indent=2)

    import shutil
    node_path = Path(__file__).parent.parent / "node-service" / "services" / "amv_model.json"
    shutil.copy(MODEL_PATH, node_path)

    acc = model["accuracy"]
    print(f"\n✅ Model v3 saved")
    print(f"   Version:     {model['version']}")
    print(f"   Samples:     {model['sampleCount']}")
    print(f"   Features:    {len(ALL_FEATURES)}")
    print(f"   Transition:  {acc['transition_cv']}")
    print(f"   Effect:      {acc['effect_cv']}")
    print(f"   Color Grade: {acc['grade_cv']}")
    print(f"   Sources:     {model.get('sources', {})}")
    print(f"\n   Restart node server to load the new model.")


def cmd_learn_edits():
    """Import user edits and retrain."""
    edits = import_user_edits()
    if not edits:
        print("  No user edits found. Edit scenes in the timeline editor first.")
        return
    print(f"  Found {len(edits)} user edits — retraining with these + existing data...")
    cmd_train(synthetic_only=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AMV Trainer v3 — 18 features, 4 targets")
    parser.add_argument("--collect",      action="store_true", help="Download AMVs and extract features")
    parser.add_argument("--train",        action="store_true", help="Train on collected + user data")
    parser.add_argument("--all",          action="store_true", help="Collect + train")
    parser.add_argument("--status",       action="store_true", help="Show dataset stats")
    parser.add_argument("--synthetic",    action="store_true", help="Train on synthetic data only")
    parser.add_argument("--learn-edits",  action="store_true", help="Import user edits + retrain")
    parser.add_argument("--urls",         type=str, default=None, help="URL list file")
    parser.add_argument("--capcut",       type=str, default=None, help="CapCut draft.json path")
    parser.add_argument("--fcp",          type=str, default=None, help="FCP XML path")
    args = parser.parse_args()

    if args.status or not any([args.collect, args.train, args.all, args.synthetic, args.learn_edits]):
        cmd_status()

    urls = []
    if args.urls and Path(args.urls).exists():
        with open(args.urls) as f:
            urls = [l.strip() for l in f if l.strip() and not l.startswith("#")]

    if args.capcut:
        extra = import_capcut_project(args.capcut)
        if extra:
            feat_path = FEATURES_DIR / "capcut_import.json"
            with open(feat_path, "w") as f:
                json.dump(extra, f, indent=2)

    if args.fcp:
        extra = import_fcp_xml(args.fcp)
        if extra:
            feat_path = FEATURES_DIR / "fcp_import.json"
            with open(feat_path, "w") as f:
                json.dump(extra, f, indent=2)

    if args.collect or args.all:
        if not urls:
            print("⚠️  No URLs. Use --urls amv_urls.txt")
        else:
            cmd_collect(urls)

    if args.train or args.all:
        cmd_train(synthetic_only=False)

    if args.synthetic:
        cmd_train(synthetic_only=True)

    if args.learn_edits:
        cmd_learn_edits()
