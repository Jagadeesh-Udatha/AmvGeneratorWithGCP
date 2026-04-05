"""
Visual Feature Extractor v2.0

Changes over v1.0:
  - face_present now returns bbox [x, y, w, h] of the LARGEST detected face
    (in original image pixel coordinates, before resize)
  - face_bbox is always present in the return dict:
      {"x": int, "y": int, "w": int, "h": int} | None
  - Added remove_background(image_path) -> PNG path using rembg (optional)
  - Preserved all v1.0 features unchanged

Features extracted (11 + bbox):
  mean_brightness      -- 0-1, average pixel luminance
  brightness_variance  -- 0-1, how much brightness varies
  dominant_hue         -- 0-360, most common hue (HSV)
  saturation           -- 0-1, average color saturation
  color_temperature    -- 0-1, warm (1.0) vs cool (0.0)
  edge_density         -- 0-1, how many edges (detail/complexity)
  face_present         -- 0 or 1
  face_bbox            -- {x, y, w, h} in original px or None
  dark_scene           -- 0 or 1 (brightness < 0.3)
  action_scene         -- 0 or 1 (edge_density > 0.15 and saturation > 0.4)
  contrast             -- 0-1, std of luminance
  warm_dominant        -- 0 or 1 (dominant hue in warm range)
"""

import os
import tempfile

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

# rembg is optional -- installed via: pip install rembg onnxruntime
try:
    from rembg import remove as rembg_remove
    HAS_REMBG = True
except ImportError:
    HAS_REMBG = False


# ---------------------------------------------------------------------------
# PUBLIC API
# ---------------------------------------------------------------------------

def extract_features(image_path: str) -> dict:
    """
    Extract visual features from an image file.
    Returns a dict with all features. face_bbox is in original image pixels.
    Returns safe fallback dict if the image cannot be read.
    """
    if not os.path.exists(image_path):
        return _fallback_features()

    if HAS_CV2:
        return _extract_cv2(image_path)
    elif HAS_PIL:
        return _extract_pil(image_path)
    else:
        return _fallback_features()


def remove_background(image_path: str, output_path: str = None) -> str:
    """
    Remove background from an image using rembg.
    Returns path to a transparent RGBA PNG.

    Args:
        image_path:  source image (any format)
        output_path: destination PNG (auto-generated if None)

    Returns:
        Absolute path to the output PNG.

    Raises:
        RuntimeError  if rembg is not installed or processing fails.
        FileNotFoundError  if image_path does not exist.
    """
    if not HAS_REMBG:
        raise RuntimeError(
            "rembg not installed. Run: pip install rembg onnxruntime"
        )
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Image not found: {image_path}")

    if output_path is None:
        base    = os.path.splitext(os.path.basename(image_path))[0]
        tmp_dir = tempfile.gettempdir()
        output_path = os.path.join(tmp_dir, f"{base}_nobg.png")

    with open(image_path, "rb") as f:
        input_data = f.read()

    # rembg.remove() returns bytes of a PNG with RGBA alpha channel
    result_bytes = rembg_remove(input_data)

    with open(output_path, "wb") as f:
        f.write(result_bytes)

    if not os.path.exists(output_path) or os.path.getsize(output_path) < 100:
        raise RuntimeError("rembg produced an empty output file")

    return output_path


# ---------------------------------------------------------------------------
# INTERNAL IMPLEMENTATIONS
# ---------------------------------------------------------------------------

def _extract_cv2(image_path: str) -> dict:
    """OpenCV-based extraction -- more accurate, returns real face bbox."""
    img = cv2.imread(image_path)
    if img is None:
        return _fallback_features()

    orig_h, orig_w = img.shape[:2]

    # Resize for speed (max 512px on longest side) but keep original dims for bbox
    scale = min(512 / max(orig_h, orig_w, 1), 1.0)
    img_small = cv2.resize(img, (int(orig_w * scale), int(orig_h * scale))) if scale < 1.0 else img

    gray = cv2.cvtColor(img_small, cv2.COLOR_BGR2GRAY)
    hsv  = cv2.cvtColor(img_small, cv2.COLOR_BGR2HSV)

    # Brightness
    bv              = gray.astype(float) / 255.0
    mean_brightness = float(bv.mean())
    brightness_variance = float(bv.std())
    contrast        = brightness_variance

    # Saturation + dominant hue
    saturation   = float(hsv[:, :, 1].astype(float).mean() / 255.0)
    hue_hist     = cv2.calcHist([hsv], [0], None, [180], [0, 180])
    dominant_hue = float(hue_hist.argmax() * 2)  # OpenCV 0-180 -> 0-360

    # Color temperature: R vs B mean ratio
    b, g, r   = cv2.split(img_small)
    r_mean    = float(r.astype(float).mean())
    b_mean    = float(b.astype(float).mean())
    color_temp = r_mean / (r_mean + b_mean + 1e-9)

    # Edge density via Canny
    edges        = cv2.Canny(gray, 50, 150)
    edge_density = float(edges.astype(float).mean() / 255.0)

    # Face detection -- bbox in original image coordinates
    face_present = 0
    face_bbox    = None
    try:
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        if os.path.exists(cascade_path):
            clf   = cv2.CascadeClassifier(cascade_path)
            faces = clf.detectMultiScale(
                gray,
                scaleFactor=1.1,
                minNeighbors=4,
                minSize=(25, 25),
            )
            if len(faces) > 0:
                face_present = 1
                # Use largest face by area
                x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
                # Scale detection coordinates back to original image space
                inv = (1.0 / scale) if scale < 1.0 else 1.0
                face_bbox = {
                    "x": int(x * inv),
                    "y": int(y * inv),
                    "w": int(w * inv),
                    "h": int(h * inv),
                }
    except Exception:
        pass

    dark_scene    = 1 if mean_brightness < 0.3 else 0
    action_scene  = 1 if (edge_density > 0.15 and saturation > 0.4) else 0
    warm_dominant = 1 if (dominant_hue < 60 or dominant_hue > 300) else 0

    return {
        "mean_brightness":     round(mean_brightness, 3),
        "brightness_variance": round(brightness_variance, 3),
        "dominant_hue":        round(dominant_hue, 1),
        "saturation":          round(saturation, 3),
        "color_temperature":   round(color_temp, 3),
        "edge_density":        round(edge_density, 3),
        "face_present":        face_present,
        "face_bbox":           face_bbox,
        "dark_scene":          dark_scene,
        "action_scene":        action_scene,
        "contrast":            round(contrast, 3),
        "warm_dominant":       warm_dominant,
    }


def _extract_pil(image_path: str) -> dict:
    """PIL-based extraction -- fallback when OpenCV is unavailable. No face detection."""
    try:
        img = Image.open(image_path)
    except Exception:
        return _fallback_features()

    img.thumbnail((512, 512))
    img_rgb  = img.convert("RGB")
    img_gray = img.convert("L")

    gray_stat       = ImageStat.Stat(img_gray)
    mean_brightness = gray_stat.mean[0] / 255.0
    brightness_variance = gray_stat.stddev[0] / 255.0
    contrast        = brightness_variance

    try:
        img_hsv      = img.convert("HSV")
        hsv_stat     = ImageStat.Stat(img_hsv)
        dominant_hue = hsv_stat.mean[0] / 255.0 * 360.0
        saturation   = hsv_stat.mean[1] / 255.0
    except Exception:
        dominant_hue = 180.0
        saturation   = 0.5

    rgb_stat             = ImageStat.Stat(img_rgb)
    r_mean, g_mean, b_mean = rgb_stat.mean
    color_temp           = r_mean / (r_mean + b_mean + 1e-9)

    edges        = img_gray.filter(ImageFilter.FIND_EDGES)
    edge_density = ImageStat.Stat(edges).mean[0] / 255.0

    dark_scene    = 1 if mean_brightness < 0.3 else 0
    action_scene  = 1 if (edge_density > 0.15 and saturation > 0.4) else 0
    warm_dominant = 1 if (dominant_hue < 60 or dominant_hue > 300) else 0

    return {
        "mean_brightness":     round(mean_brightness, 3),
        "brightness_variance": round(brightness_variance, 3),
        "dominant_hue":        round(dominant_hue, 1),
        "saturation":          round(saturation, 3),
        "color_temperature":   round(color_temp, 3),
        "edge_density":        round(edge_density, 3),
        "face_present":        0,     # PIL has no face detection
        "face_bbox":           None,
        "dark_scene":          dark_scene,
        "action_scene":        action_scene,
        "contrast":            round(contrast, 3),
        "warm_dominant":       warm_dominant,
    }


def _fallback_features() -> dict:
    """Safe neutral defaults when no image library is available."""
    return {
        "mean_brightness":     0.5,
        "brightness_variance": 0.2,
        "dominant_hue":        180.0,
        "saturation":          0.5,
        "color_temperature":   0.5,
        "edge_density":        0.3,
        "face_present":        0,
        "face_bbox":           None,
        "dark_scene":          0,
        "action_scene":        0,
        "contrast":            0.2,
        "warm_dominant":       0,
    }


# ---------------------------------------------------------------------------
# CLI test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("Usage: python visual_features.py <image_path> [--remove-bg]")
        print(f"  OpenCV: {'yes' if HAS_CV2 else 'no (pip install opencv-python)'}")
        print(f"  PIL:    {'yes' if HAS_PIL else 'no (pip install Pillow)'}")
        print(f"  rembg:  {'yes' if HAS_REMBG else 'no (pip install rembg onnxruntime)'}")
        sys.exit(1)

    if "--remove-bg" in sys.argv:
        try:
            out = remove_background(sys.argv[1])
            print(f"Background removed: {out}")
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        features = extract_features(sys.argv[1])
        print(json.dumps(features, indent=2))
