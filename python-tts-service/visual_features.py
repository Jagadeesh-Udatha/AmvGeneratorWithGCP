"""
Visual Feature Extractor v1.0

Extracts visual features from images for the AMV edit classifier.
Uses PIL/Pillow as primary (always available), OpenCV as optional enhancement.

Features extracted (11):
  mean_brightness      — 0-1, average pixel luminance
  brightness_variance  — 0-1, how much brightness varies across the image
  dominant_hue         — 0-360, most common hue in HSV space
  saturation           — 0-1, average color saturation
  color_temperature    — 0-1, warm (1.0) vs cool (0.0) based on R/B ratio
  edge_density         — 0-1, how many edges (detail/complexity)
  face_present         — 0 or 1, whether a face-like region is detected (basic)
  dark_scene           — 0 or 1, if mean brightness < 0.3
  action_scene         — 0 or 1, if edge density > 0.5 and saturation > 0.4
  contrast             — 0-1, standard deviation of luminance
  warm_dominant        — 0 or 1, if dominant hue is in warm range (0-60 or 300-360)

Usage:
  from visual_features import extract_features
  features = extract_features("/path/to/image.jpg")
"""

import os
import math
import struct
from collections import Counter

# Try OpenCV first, fall back to PIL-only
try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

try:
    from PIL import Image, ImageStat, ImageFilter
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def extract_features(image_path: str) -> dict:
    """
    Extract visual features from an image file.
    Returns a dict of 11 features, all normalized to 0-1 (or 0-360 for hue).
    Returns None if the image can't be read.
    """
    if not os.path.exists(image_path):
        return None

    if HAS_CV2:
        return _extract_cv2(image_path)
    elif HAS_PIL:
        return _extract_pil(image_path)
    else:
        return _fallback_features()


def _extract_cv2(image_path: str) -> dict:
    """OpenCV-based extraction (more accurate)."""
    img = cv2.imread(image_path)
    if img is None:
        return _fallback_features()

    # Resize for speed (max 512px on longest side)
    h, w = img.shape[:2]
    scale = min(512 / max(h, w), 1.0)
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)))

    # Convert color spaces
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    # Brightness
    brightness_values = gray.astype(float) / 255.0
    mean_brightness = float(brightness_values.mean())
    brightness_variance = float(brightness_values.std())
    contrast = brightness_variance  # alias

    # HSV features
    hue_channel = hsv[:, :, 0].astype(float) * 2  # OpenCV hue is 0-180, convert to 0-360
    sat_channel = hsv[:, :, 1].astype(float) / 255.0
    saturation = float(sat_channel.mean())

    # Dominant hue: histogram peak
    hue_hist = cv2.calcHist([hsv], [0], None, [180], [0, 180])
    dominant_hue = float(hue_hist.argmax() * 2)  # convert to 0-360

    # Color temperature: R/B ratio (warm = more red, cool = more blue)
    b, g, r = cv2.split(img)
    r_mean = float(r.astype(float).mean())
    b_mean = float(b.astype(float).mean())
    color_temp = r_mean / (r_mean + b_mean + 1e-9)  # 0-1, higher = warmer

    # Edge density
    edges = cv2.Canny(gray, 50, 150)
    edge_density = float(edges.astype(float).mean() / 255.0)

    # Face detection (Haar cascade — basic but fast)
    face_present = 0
    try:
        face_cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        if os.path.exists(face_cascade_path):
            face_cascade = cv2.CascadeClassifier(face_cascade_path)
            faces = face_cascade.detectMultiScale(gray, scaleFactor=1.3, minNeighbors=3, minSize=(30, 30))
            face_present = 1 if len(faces) > 0 else 0
    except Exception:
        pass

    # Derived
    dark_scene = 1 if mean_brightness < 0.3 else 0
    action_scene = 1 if (edge_density > 0.15 and saturation > 0.4) else 0
    warm_dominant = 1 if (dominant_hue < 60 or dominant_hue > 300) else 0

    return {
        "mean_brightness": round(mean_brightness, 3),
        "brightness_variance": round(brightness_variance, 3),
        "dominant_hue": round(dominant_hue, 1),
        "saturation": round(saturation, 3),
        "color_temperature": round(color_temp, 3),
        "edge_density": round(edge_density, 3),
        "face_present": face_present,
        "dark_scene": dark_scene,
        "action_scene": action_scene,
        "contrast": round(contrast, 3),
        "warm_dominant": warm_dominant,
    }


def _extract_pil(image_path: str) -> dict:
    """PIL-based extraction (fallback, no OpenCV needed)."""
    try:
        img = Image.open(image_path)
    except Exception:
        return _fallback_features()

    # Resize for speed
    img.thumbnail((512, 512))
    img_rgb = img.convert("RGB")
    img_gray = img.convert("L")
    img_hsv = img.convert("HSV")

    # Brightness from grayscale
    gray_stat = ImageStat.Stat(img_gray)
    mean_brightness = gray_stat.mean[0] / 255.0
    brightness_variance = gray_stat.stddev[0] / 255.0
    contrast = brightness_variance

    # HSV stats
    hsv_stat = ImageStat.Stat(img_hsv)
    # PIL HSV: H=0-255, S=0-255, V=0-255
    dominant_hue = hsv_stat.mean[0] / 255.0 * 360.0  # convert to 0-360
    saturation = hsv_stat.mean[1] / 255.0

    # Color temperature from RGB
    rgb_stat = ImageStat.Stat(img_rgb)
    r_mean, g_mean, b_mean = rgb_stat.mean
    color_temp = r_mean / (r_mean + b_mean + 1e-9)

    # Edge density: apply edge filter, measure mean
    edges = img_gray.filter(ImageFilter.FIND_EDGES)
    edge_stat = ImageStat.Stat(edges)
    edge_density = edge_stat.mean[0] / 255.0

    # Face detection: not available in PIL — default to 0
    face_present = 0

    # Derived
    dark_scene = 1 if mean_brightness < 0.3 else 0
    action_scene = 1 if (edge_density > 0.15 and saturation > 0.4) else 0
    warm_dominant = 1 if (dominant_hue < 60 or dominant_hue > 300) else 0

    return {
        "mean_brightness": round(mean_brightness, 3),
        "brightness_variance": round(brightness_variance, 3),
        "dominant_hue": round(dominant_hue, 1),
        "saturation": round(saturation, 3),
        "color_temperature": round(color_temp, 3),
        "edge_density": round(edge_density, 3),
        "face_present": face_present,
        "dark_scene": dark_scene,
        "action_scene": action_scene,
        "contrast": round(contrast, 3),
        "warm_dominant": warm_dominant,
    }


def _fallback_features() -> dict:
    """Default features when no image library is available."""
    return {
        "mean_brightness": 0.5,
        "brightness_variance": 0.2,
        "dominant_hue": 180.0,
        "saturation": 0.5,
        "color_temperature": 0.5,
        "edge_density": 0.3,
        "face_present": 0,
        "dark_scene": 0,
        "action_scene": 0,
        "contrast": 0.2,
        "warm_dominant": 0,
    }


# ── CLI test ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys
    import json
    if len(sys.argv) < 2:
        print("Usage: python visual_features.py <image_path>")
        print(f"  OpenCV: {'✅' if HAS_CV2 else '❌ (pip install opencv-python)'}")
        print(f"  PIL:    {'✅' if HAS_PIL else '❌ (pip install Pillow)'}")
        sys.exit(1)

    features = extract_features(sys.argv[1])
    print(json.dumps(features, indent=2))
