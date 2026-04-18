#!/bin/bash
# ============================================================
# Fix: Install mediapipe in the SAME Python that runs beat_detector.py
# ============================================================

echo "=== Finding which Python runs beat_detector.py ==="
PYTHON=$(which python3)
echo "System python3: $PYTHON"
echo "Version: $($PYTHON --version)"

echo ""
echo "=== Checking if mediapipe already installed in system Python ==="
$PYTHON -c "import mediapipe; print('Already installed:', mediapipe.__version__)" 2>/dev/null || {
    echo "Not installed — installing now..."
    $PYTHON -m pip install mediapipe
}

echo ""
echo "=== Verifying installation ==="
$PYTHON -c "
import mediapipe as mp
print('✅ mediapipe', mp.__version__, 'installed in system Python')
print('   Path:', mp.__file__)

# Verify face landmarker task file exists
import os
model_path = os.path.join(os.path.dirname(os.path.abspath('beat_detector.py')), 'face_landmarker.task')
if os.path.exists(model_path):
    size_mb = os.path.getsize(model_path) / (1024*1024)
    print(f'✅ face_landmarker.task found ({size_mb:.1f}MB)')
else:
    print('❌ face_landmarker.task NOT found — run:')
    print('   python3 -c \"import urllib.request; urllib.request.urlretrieve(')
    print('     \'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task\',')
    print('     \'face_landmarker.task\')\"')
"

echo ""
echo "=== Done. Now restart beat_detector.py: ==="
echo "   python3 beat_detector.py"
echo ""
echo "You should see: ✅ Face landmarker loaded (blendshapes enabled)"