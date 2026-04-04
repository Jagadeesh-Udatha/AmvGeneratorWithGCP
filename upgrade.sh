#!/usr/bin/env bash
# upgrade.sh — applies all v2.1 fixes to your existing project
# Usage: bash upgrade.sh /path/to/your/anime-video-generator

set -e

PROJECT="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔧 Applying anime-video-generator v2.1 fixes to: $PROJECT"
echo ""

# 1. Copy fixed Node files
echo "📦 Updating Node service files..."
cp "$SCRIPT_DIR/node-service/server.js"                          "$PROJECT/node-service/server.js"
cp "$SCRIPT_DIR/node-service/services/scriptGenerator.js"       "$PROJECT/node-service/services/scriptGenerator.js"
cp "$SCRIPT_DIR/node-service/services/videoGenerator.js"        "$PROJECT/node-service/services/videoGenerator.js"
echo "   ✅ Node files updated"

# 2. Copy fixed Python TTS
echo "🐍 Updating Python TTS service..."
cp "$SCRIPT_DIR/python-tts-service/app.py"  "$PROJECT/python-tts-service/app.py"
echo "   ✅ Python app.py updated"

# 3. Upgrade edge-tts
echo "🎤 Upgrading edge-tts..."
cd "$PROJECT/python-tts-service"
if command -v pip3 &> /dev/null; then
  pip3 install --upgrade edge-tts --quiet && echo "   ✅ edge-tts upgraded"
elif command -v pip &> /dev/null; then
  pip install --upgrade edge-tts --quiet && echo "   ✅ edge-tts upgraded"
else
  echo "   ⚠️  pip not found — manually run: pip install --upgrade edge-tts"
fi

# 4. Check ffmpeg subtitle support
echo "🎥 Checking FFmpeg subtitle support..."
if ffmpeg -filters 2>&1 | grep -q "\bass\b" || ffmpeg -buildconf 2>&1 | grep -q "enable-libass"; then
  echo "   ✅ libass found — subtitles will work"
elif ffmpeg -filters 2>&1 | grep -q "\bdrawtext\b" || ffmpeg -buildconf 2>&1 | grep -q "enable-libfreetype"; then
  echo "   ✅ drawtext found — subtitles will work (basic mode)"
else
  echo "   ⚠️  No subtitle support in current ffmpeg build"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "      Run: brew reinstall ffmpeg"
    echo "      Or:  brew install ffmpeg"
  else
    echo "      Run: sudo apt install ffmpeg"
  fi
fi

echo ""
echo "✅ All fixes applied!"
echo ""
echo "Restart both services to take effect:"
echo "  Terminal 1: cd $PROJECT/python-tts-service && python app.py"
echo "  Terminal 2: cd $PROJECT/node-service && npm run dev"
