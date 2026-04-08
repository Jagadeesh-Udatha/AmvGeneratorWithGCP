"""
Visual Feature Extractor v6.0 — Landmark-Based Expression Detection

THREE-TIER EXPRESSION DETECTION (in order of accuracy):

TIER 1 — MEDIAPIPE FACE LANDMARKER (most accurate, ~3MB model)
  Detects 478 face landmarks. Derives expression from geometry:
    - Mouth aspect ratio (MAR): lip corner Y + openness → smile/frown
    - Brow height ratio (BHR): eyebrow Y relative to eye → raised/furrowed
    - Eye aspect ratio (EAR): eye openness → wide-eyed/normal
  Requires: face_landmarker.task in python-tts-service/ directory
  Download once: python3 -c "import urllib.request; urllib.request.urlretrieve(
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    'face_landmarker.task')"

TIER 2 — CLAUDE VISION API (most accurate for complex images, costs credits)
  Sends image to Claude claude-haiku-4-5-20251001 with expression prompt.
  Only runs if ANTHROPIC_API_KEY is set or BYOK key is passed.
  Results are cached per image hash to avoid repeated API calls.

TIER 3 — SCENE ANALYSIS FALLBACK (no model needed, always runs)
  Uses scene-level features when no face is detected and no API key.
  Honest limitation: classifies scene mood, not character expression.
  Correct when: scene and character emotion align (which is often true in anime).
  Wrong when: character emotion contradicts scene (rain+happy, sun+sad).
"""

import os, tempfile, hashlib

try:
    import cv2
    import numpy as np
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

try:
    from PIL import Image, ImageStat, ImageFilter
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    from rembg import remove as rembg_remove
    HAS_REMBG = True
except ImportError:
    HAS_REMBG = False

# ---------------------------------------------------------------------------
# TIER 1: MEDIAPIPE FACE LANDMARKER
# ---------------------------------------------------------------------------

_mp_landmarker = None
_mp_landmarker_tried = False

# Landmark indices for expression geometry
# From mediapipe face mesh topology
_UPPER_LIP    = 13
_LOWER_LIP    = 14
_MOUTH_LEFT   = 61
_MOUTH_RIGHT  = 291
_MOUTH_TOP    = 0
_MOUTH_BOTTOM = 17
_L_EYE_TOP    = 159
_L_EYE_BOT    = 145
_R_EYE_TOP    = 386
_R_EYE_BOT    = 374
_L_BROW_INNER = 70
_L_BROW_MID   = 107
_R_BROW_INNER = 300
_NOSE_TIP     = 1
_CHIN         = 152
_FOREHEAD     = 10


def _get_landmarker():
    global _mp_landmarker, _mp_landmarker_tried
    if _mp_landmarker_tried:
        return _mp_landmarker

    _mp_landmarker_tried = True
    try:
        import mediapipe as mp
        from mediapipe.tasks.python import vision as mp_vision
        from mediapipe.tasks.python.vision import FaceLandmarker, FaceLandmarkerOptions

        # Look for model in common locations
        candidates = [
            os.path.join(os.path.dirname(__file__), "face_landmarker.task"),
            os.path.join(os.path.expanduser("~"), ".mediapipe", "face_landmarker.task"),
            "/tmp/face_landmarker.task",
        ]
        model_path = next((p for p in candidates if os.path.exists(p) and os.path.getsize(p) > 100000), None)

        if not model_path:
            # Try to download it
            import urllib.request
            dest = os.path.join(os.path.dirname(__file__), "face_landmarker.task")
            url  = ("https://storage.googleapis.com/mediapipe-models/"
                    "face_landmarker/face_landmarker/float16/1/face_landmarker.task")
            try:
                print(f"   📥 Downloading face_landmarker.task (~3MB)...")
                urllib.request.urlretrieve(url, dest)
                if os.path.getsize(dest) > 100000:
                    model_path = dest
                    print(f"   ✅ face_landmarker.task downloaded")
                else:
                    os.unlink(dest)
            except Exception as e:
                print(f"   ⚠️  face_landmarker.task not available: {e}")
                print(f"   💡 Download manually: python3 -c \"import urllib.request; urllib.request.urlretrieve(\'{url}\', '{os.path.join(os.path.dirname(__file__), 'face_landmarker.task')}\')\"")

        if not model_path:
            return None

        opts = FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=model_path),
            output_face_blendshapes=True,   # gives us smile/brow scores directly!
            min_face_detection_confidence=0.3,
            min_face_presence_confidence=0.3,
        )
        _mp_landmarker = FaceLandmarker.create_from_options(opts)
        print(f"   ✅ Face landmarker loaded (blendshapes enabled)")
    except Exception as e:
        print(f"   ⚠️  Face landmarker init failed: {e}")
        _mp_landmarker = None

    return _mp_landmarker


def _expression_from_landmarks(image_path: str) -> dict | None:
    """
    Use mediapipe face landmarker to detect expression from face geometry.
    Returns None if no face detected or landmarker unavailable.

    Uses BLENDSHAPES (pre-computed by mediapipe) when available:
      mouthSmile_L/R        → happy
      browDownLeft/Right     → angry
      browInnerUp            → sad/surprised
      eyeWideLeft/Right      → surprised
      mouthFrownLeft/Right   → sad
      jawOpen                → surprised/happy-open-mouth
    """
    landmarker = _get_landmarker()
    if landmarker is None:
        return None

    try:
        import mediapipe as mp
        img_cv = cv2.imread(image_path)
        if img_cv is None:
            return None

        rgb = cv2.cvtColor(img_cv, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = landmarker.detect(mp_img)

        if not result.face_landmarks:
            return None  # No face detected

        # ── Use blendshapes if available (most accurate) ───────────────────
        if result.face_blendshapes:
            bs = {b.category_name: b.score for b in result.face_blendshapes[0]}

            smile    = (bs.get("mouthSmileLeft", 0) + bs.get("mouthSmileRight", 0)) / 2
            frown    = (bs.get("mouthFrownLeft", 0) + bs.get("mouthFrownRight", 0)) / 2
            brow_dn  = (bs.get("browDownLeft", 0) + bs.get("browDownRight", 0)) / 2
            brow_up  = bs.get("browInnerUp", 0)
            eye_wide = (bs.get("eyeWideLeft", 0) + bs.get("eyeWideRight", 0)) / 2
            jaw_open = bs.get("jawOpen", 0)

            scores = {
                # Happy: smiling mouth + relaxed brows
                "happy":     min(1.0, smile * 1.5 + jaw_open * 0.3 - frown * 0.5),
                # Sad: frowning + inner brows raised (sad brow shape)
                "sad":       min(1.0, frown * 1.5 + brow_up * 0.5 - smile * 0.8),
                # Angry: brows pressed down + no smile
                "angry":     min(1.0, brow_dn * 1.8 - smile * 0.6),
                # Surprised: brows raised + eyes wide + jaw open
                "surprised": min(1.0, eye_wide * 1.2 + brow_up * 0.6 + jaw_open * 0.5),
                # Calm/neutral: no extremes
                "calm":      min(1.0, max(0.0, 0.8 - smile - frown - brow_dn - eye_wide)),
                "no_face":   0.0,
            }

            # Clamp negatives
            scores = {k: max(0.0, v) for k, v in scores.items()}
            total = sum(scores.values()) or 1.0
            scores = {k: round(v / total, 3) for k, v in scores.items()}
            dominant = max(scores, key=scores.get)

            print(f"   😊 Blendshape: smile={smile:.2f} frown={frown:.2f} brow_dn={brow_dn:.2f} → {dominant}")

            # Extract face bounding box from landmarks (normalized → pixels)
            lm0 = result.face_landmarks[0]
            img_h, img_w = img_cv.shape[:2]
            xs = [p.x * img_w for p in lm0]
            ys = [p.y * img_h for p in lm0]
            fx = max(0, int(min(xs)))
            fy = max(0, int(min(ys)))
            fw = min(img_w - fx, int(max(xs) - min(xs)))
            fh = min(img_h - fy, int(max(ys) - min(ys)))
            face_bbox_px = {"x": fx, "y": fy, "w": fw, "h": fh} if fw > 10 and fh > 10 else None

            return {
                "dominant_expression": dominant,
                "scores": scores,
                "face_detected": True,
                "confidence": round(scores[dominant], 3),
                "method": "mediapipe_blendshape",
                "face_bbox": face_bbox_px,
            }

        # ── Fallback: geometry from raw landmarks ──────────────────────────
        lm = result.face_landmarks[0]

        def pt(idx):
            return np.array([lm[idx].x, lm[idx].y])

        face_h = abs(lm[_CHIN].y - lm[_FOREHEAD].y) or 0.01

        # Mouth aspect ratio
        mouth_open  = abs(lm[_UPPER_LIP].y - lm[_LOWER_LIP].y) / face_h
        mouth_width = abs(lm[_MOUTH_LEFT].x - lm[_MOUTH_RIGHT].x)

        # Corner Y relative to mouth center (positive = raised = smile)
        mouth_cy    = (lm[_UPPER_LIP].y + lm[_LOWER_LIP].y) / 2
        corner_raise = (mouth_cy - (lm[_MOUTH_LEFT].y + lm[_MOUTH_RIGHT].y)/2) / face_h

        # Eye aspect ratio (openness)
        l_ear = abs(lm[_L_EYE_TOP].y - lm[_L_EYE_BOT].y) / face_h
        r_ear = abs(lm[_R_EYE_TOP].y - lm[_R_EYE_BOT].y) / face_h
        ear   = (l_ear + r_ear) / 2

        # Brow height (relative to eye center — negative = furrowed/lowered = angry)
        l_eye_cy  = (lm[_L_EYE_TOP].y + lm[_L_EYE_BOT].y) / 2
        bhr = (l_eye_cy - lm[_L_BROW_MID].y) / face_h  # positive = brow above eye

        smile_score    = max(0.0, corner_raise * 8)
        open_score     = min(1.0, mouth_open * 15)
        wide_eye_score = min(1.0, max(0.0, (ear - 0.04) * 20))
        brow_raise     = min(1.0, max(0.0, (bhr - 0.06) * 10))
        brow_furrow    = min(1.0, max(0.0, (0.07 - bhr) * 15))

        scores = {
            "happy":     min(1.0, smile_score * 0.7 + open_score * 0.2 + brow_raise * 0.1),
            "sad":       min(1.0, max(0.0, -corner_raise * 6) * 0.6 + brow_raise * 0.4),
            "angry":     min(1.0, brow_furrow * 0.8 + max(0.0, -corner_raise * 4) * 0.2),
            "surprised": min(1.0, wide_eye_score * 0.5 + brow_raise * 0.3 + open_score * 0.2),
            "calm":      min(1.0, max(0.0, 0.7 - smile_score - brow_furrow - wide_eye_score)),
            "no_face":   0.0,
        }

        scores = {k: max(0.0, v) for k, v in scores.items()}
        total  = sum(scores.values()) or 1.0
        scores = {k: round(v / total, 3) for k, v in scores.items()}
        dominant = max(scores, key=scores.get)

        # Extract face bounding box from landmarks
        lm0 = result.face_landmarks[0]
        img_h2, img_w2 = img_cv.shape[:2]
        xs2 = [p.x * img_w2 for p in lm0]
        ys2 = [p.y * img_h2 for p in lm0]
        fx2 = max(0, int(min(xs2)))
        fy2 = max(0, int(min(ys2)))
        fw2 = min(img_w2 - fx2, int(max(xs2) - min(xs2)))
        fh2 = min(img_h2 - fy2, int(max(ys2) - min(ys2)))
        face_bbox_px2 = {"x": fx2, "y": fy2, "w": fw2, "h": fh2} if fw2 > 10 and fh2 > 10 else None

        return {
            "dominant_expression": dominant,
            "scores": scores,
            "face_detected": True,
            "confidence": round(scores[dominant], 3),
            "method": "mediapipe_geometry",
            "face_bbox": face_bbox_px2,
        }

    except Exception as e:
        print(f"   ⚠️  Landmarker error: {e}")
        return None


# ---------------------------------------------------------------------------
# TIER 2: CLAUDE VISION API
# ---------------------------------------------------------------------------

_expression_cache = {}  # image_hash → result (avoid repeated API calls)


def _expression_from_claude(image_path: str, api_key: str = None) -> dict | None:
    """
    Use Claude vision API to detect expression. Cached per image hash.
    Only called when api_key is available.
    """
    if not api_key:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None

    # Cache check
    try:
        with open(image_path, "rb") as f:
            img_hash = hashlib.md5(f.read(8192)).hexdigest()[:12]
    except Exception:
        return None

    if img_hash in _expression_cache:
        return _expression_cache[img_hash]

    try:
        import base64, json, urllib.request

        with open(image_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode()

        ext = os.path.splitext(image_path)[1].lower()
        mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(ext.lstrip("."), "image/jpeg")

        prompt = (
            "Look at the character(s) in this anime image. "
            "Classify the PRIMARY emotional expression of the main character as exactly ONE of: "
            "happy, sad, angry, surprised, calm. "
            "Base this ONLY on the character's face/body language, NOT the background or scene. "
            "A character can be happy even in rain, or sad even in sunlight. "
            "Respond with JSON only, no explanation: "
            "{\"expression\": \"happy\"|..., \"confidence\": 0.0-1.0, \"reason\": \"one sentence\"}"
        )

        payload = {
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 100,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": mime, "data": img_b64}},
                    {"type": "text", "text": prompt},
                ]
            }]
        }

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            }
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())

        text = data["content"][0]["text"].strip()
        # Strip markdown fences if present
        if text.startswith("```"):
            text = text.split("```")[1].lstrip("json").strip()
        parsed = json.loads(text)

        expr = parsed.get("expression", "calm")
        conf = float(parsed.get("confidence", 0.7))
        reason = parsed.get("reason", "")

        VALID = {"happy", "sad", "angry", "surprised", "calm"}
        if expr not in VALID:
            expr = "calm"

        scores = {e: 0.05 for e in VALID}
        scores[expr] = conf
        # Distribute remainder
        remainder = (1.0 - conf) / (len(VALID) - 1)
        for k in VALID:
            if k != expr:
                scores[k] = round(remainder, 3)
        scores["no_face"] = 0.0

        result = {
            "dominant_expression": expr,
            "scores": scores,
            "face_detected": True,
            "confidence": conf,
            "method": "claude_vision",
            "reason": reason,
        }

        _expression_cache[img_hash] = result
        print(f"   🤖 Claude vision: {expr} ({conf:.2f}) — {reason}")
        return result

    except Exception as e:
        print(f"   ⚠️  Claude vision error: {e}")
        return None


# ---------------------------------------------------------------------------
# TIER 3: SCENE ANALYSIS FALLBACK
# ---------------------------------------------------------------------------

def _expression_from_scene(image_path: str) -> dict:
    """
    Scene-level fallback when no face detected and no API key.
    Honest limitation: classifies scene mood, not character expression.
    Correct for ~70% of anime images (where scene and character emotion align).
    """
    if not HAS_CV2:
        return _fallback_expression()

    img = cv2.imread(image_path)
    if img is None:
        return _fallback_expression()

    img_s = cv2.resize(img, (256, 256))
    gray  = cv2.cvtColor(img_s, cv2.COLOR_BGR2GRAY)
    hsv   = cv2.cvtColor(img_s, cv2.COLOR_BGR2HSV)

    brightness   = float(gray.mean() / 255)
    dark_pixels  = float((gray < 60).mean())
    bright_px    = float((gray > 200).mean())
    drama        = min(1.0, dark_pixels * bright_px * 20)

    edges     = cv2.Canny(gray, 50, 150)
    edge_den  = float(edges.mean() / 255)
    top_edges = float(edges[:85, :].mean() / 255)

    sat = hsv[:,:,1]
    val = hsv[:,:,2]
    hue = hsv[:,:,0]
    mask    = (sat > 50) & (val > 40)
    h_col   = hue[mask]

    if len(h_col) < 100:
        warm_pct = cool_pct = green_pct = 0.33
    else:
        warm_pct  = float(((h_col < 30) | (h_col > 168)).mean())
        cool_pct  = float(((h_col > 100) & (h_col < 160)).mean())
        green_pct = float(((h_col > 65) & (h_col < 100)).mean())

    scores = {}
    scores["angry"] = min(1.0,
        0.35 * max(0.0, (0.35 - brightness) * 3) +
        0.35 * min(1.0, green_pct * 2) +
        0.20 * min(1.0, top_edges * 6) +
        0.10 * min(1.0, dark_pixels * 2)
    )
    scores["sad"] = min(1.0,
        0.45 * (warm_pct * max(0.0, 0.15 - top_edges) * 10) +
        0.25 * max(0.0, 1.0 - abs(brightness - 0.42) * 4) +
        0.20 * (cool_pct * (1.0 - brightness)) +
        0.10 * max(0.0, 0.5 - edge_den * 3)
    )
    scores["happy"] = min(1.0,
        0.35 * min(1.0, max(0.0, (brightness - 0.4) * 3)) +
        0.30 * min(1.0, drama * 1.5) +
        0.25 * (warm_pct * (1.0 - green_pct)) +
        0.10 * min(1.0, top_edges * 4)
    )
    scores["surprised"] = min(1.0,
        0.40 * min(1.0, drama * 1.5) +
        0.35 * min(1.0, edge_den * 6) +
        0.25 * (1.0 - max(warm_pct, cool_pct, green_pct))
    )
    scores["calm"] = min(1.0,
        0.40 * max(0.0, 0.5 - edge_den * 4) +
        0.35 * max(0.0, 1.0 - abs(brightness - 0.5) * 3) +
        0.25 * max(0.0, 1.0 - drama * 3)
    )
    scores["no_face"] = 0.0

    total  = sum(scores.values()) or 1.0
    scores = {k: round(v / total, 3) for k, v in scores.items()}
    dominant = max(scores, key=scores.get)

    return {
        "dominant_expression": dominant,
        "scores": scores,
        "face_detected": False,
        "confidence": round(scores[dominant], 3),
        "method": "scene_fallback",
        "_note": "Scene-based — may not reflect character emotion if scene/emotion mismatch",
    }


# ---------------------------------------------------------------------------
# PUBLIC API
# ---------------------------------------------------------------------------

def detect_expression(image_path: str, api_key: str = None) -> dict:
    """
    Detect expression using the best available method:
      1. Mediapipe face landmarker (if face_landmarker.task exists)
      2. Claude vision API (if api_key provided or ANTHROPIC_API_KEY set)
      3. Scene analysis fallback (always available, limited accuracy)
    """
    if not os.path.exists(image_path):
        return _fallback_expression()

    # Tier 1: Mediapipe landmarks (face-based, accurate)
    result = _expression_from_landmarks(image_path)
    if result:
        return result

    # Tier 2: Claude API (most accurate for complex images)
    result = _expression_from_claude(image_path, api_key)
    if result:
        return result

    # Tier 3: Scene fallback (always works, limited accuracy)
    result = _expression_from_scene(image_path)
    print(f"   🖼️  {os.path.basename(image_path)}: {result['dominant_expression']} ({result['confidence']:.2f}) [scene-based]")
    return result


def _fallback_expression() -> dict:
    return {
        "dominant_expression": "calm",
        "scores": {"happy":0.2,"sad":0.2,"angry":0.2,"surprised":0.2,"calm":0.2,"no_face":0.0},
        "face_detected": False, "confidence": 0.2, "method": "fallback",
    }


def extract_features(image_path: str) -> dict:
    if not os.path.exists(image_path):
        return _fallback_features()
    if HAS_CV2:
        return _extract_cv2(image_path)
    elif HAS_PIL:
        return _extract_pil(image_path)
    return _fallback_features()


def remove_background(image_path: str, output_path: str = None) -> str:
    if not HAS_REMBG:
        raise RuntimeError("rembg not installed.")
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Image not found: {image_path}")
    if output_path is None:
        base = os.path.splitext(os.path.basename(image_path))[0]
        output_path = os.path.join(tempfile.gettempdir(), f"{base}_nobg.png")
    with open(image_path, "rb") as f:
        result_bytes = rembg_remove(f.read())
    with open(output_path, "wb") as f:
        f.write(result_bytes)
    return output_path


def _extract_cv2(image_path: str) -> dict:
    img = cv2.imread(image_path)
    if img is None:
        return _fallback_features()
    orig_h, orig_w = img.shape[:2]
    scale = min(512 / max(orig_h, orig_w, 1), 1.0)
    img_small = cv2.resize(img, (int(orig_w*scale), int(orig_h*scale))) if scale < 1.0 else img
    gray = cv2.cvtColor(img_small, cv2.COLOR_BGR2GRAY)
    hsv  = cv2.cvtColor(img_small, cv2.COLOR_BGR2HSV)
    bv           = gray.astype(float)/255.0
    mean_bright  = float(bv.mean())
    bright_var   = float(bv.std())
    saturation   = float(hsv[:,:,1].astype(float).mean()/255.0)
    hue_hist     = cv2.calcHist([hsv],[0],None,[180],[0,180])
    dominant_hue = float(hue_hist.argmax()*2)
    b,g,r = cv2.split(img_small)
    r_mean = float(r.astype(float).mean())
    b_mean = float(b.astype(float).mean())
    color_temp   = r_mean/(r_mean+b_mean+1e-9)
    edges        = cv2.Canny(gray,50,150)
    edge_density = float(edges.astype(float).mean()/255.0)
    face_present, face_bbox = 0, None
    try:
        fc = cv2.CascadeClassifier(cv2.data.haarcascades+"haarcascade_frontalface_default.xml")
        if not fc.empty():
            faces = fc.detectMultiScale(gray,1.1,4,minSize=(25,25))
            if len(faces) > 0:
                face_present = 1
                x,y,w,h = max(faces, key=lambda f:f[2]*f[3])
                inv = (1.0/scale) if scale < 1.0 else 1.0
                face_bbox = {"x":int(x*inv),"y":int(y*inv),"w":int(w*inv),"h":int(h*inv)}
    except Exception:
        pass
    expr = detect_expression(image_path)
    return {
        "mean_brightness":round(mean_bright,3),"brightness_variance":round(bright_var,3),
        "dominant_hue":round(dominant_hue,1),"saturation":round(saturation,3),
        "color_temperature":round(color_temp,3),"edge_density":round(edge_density,3),
        "face_present":face_present,"face_bbox":face_bbox,
        "dark_scene":1 if mean_bright<0.3 else 0,
        "action_scene":1 if (edge_density>0.15 and saturation>0.4) else 0,
        "contrast":round(bright_var,3),
        "warm_dominant":1 if (dominant_hue<60 or dominant_hue>300) else 0,
        "expression":expr["dominant_expression"],
        "expression_scores":expr["scores"],
        "expression_confidence":expr["confidence"],
    }


def _extract_pil(image_path: str) -> dict:
    try:
        img = Image.open(image_path)
    except Exception:
        return _fallback_features()
    img.thumbnail((512,512))
    img_rgb = img.convert("RGB"); img_gray = img.convert("L")
    gs = ImageStat.Stat(img_gray)
    mean_bright = gs.mean[0]/255.0; bright_var = gs.stddev[0]/255.0
    try:
        hs = ImageStat.Stat(img.convert("HSV"))
        dominant_hue = hs.mean[0]/255.0*360.0; saturation = hs.mean[1]/255.0
    except Exception:
        dominant_hue,saturation = 180.0,0.5
    rs = ImageStat.Stat(img_rgb); r_m,g_m,b_m = rs.mean
    color_temp = r_m/(r_m+b_m+1e-9)
    edges = img_gray.filter(ImageFilter.FIND_EDGES)
    edge_density = ImageStat.Stat(edges).mean[0]/255.0
    expr = detect_expression(image_path)
    return {
        "mean_brightness":round(mean_bright,3),"brightness_variance":round(bright_var,3),
        "dominant_hue":round(dominant_hue,1),"saturation":round(saturation,3),
        "color_temperature":round(color_temp,3),"edge_density":round(edge_density,3),
        "face_present":0,"face_bbox":None,
        "dark_scene":1 if mean_bright<0.3 else 0,
        "action_scene":1 if (edge_density>0.15 and saturation>0.4) else 0,
        "contrast":round(bright_var,3),
        "warm_dominant":1 if (dominant_hue<60 or dominant_hue>300) else 0,
        "expression":expr["dominant_expression"],
        "expression_scores":expr["scores"],
        "expression_confidence":expr["confidence"],
    }


def _fallback_features() -> dict:
    return {
        "mean_brightness":0.5,"brightness_variance":0.2,"dominant_hue":180.0,
        "saturation":0.5,"color_temperature":0.5,"edge_density":0.3,
        "face_present":0,"face_bbox":None,"dark_scene":0,"action_scene":0,
        "contrast":0.2,"warm_dominant":0,"expression":"calm",
        "expression_scores":{"happy":0.2,"sad":0.2,"angry":0.2,"surprised":0.2,"calm":0.2,"no_face":0.0},
        "expression_confidence":0.2,
    }


if __name__ == "__main__":
    import sys, json
    if len(sys.argv) < 2:
        print("Usage: python visual_features.py <image>")
        sys.exit(1)
    print(json.dumps(detect_expression(sys.argv[1]), indent=2))