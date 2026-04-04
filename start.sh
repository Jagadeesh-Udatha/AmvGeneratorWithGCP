#!/bin/bash
# ============================================
# Anime Video Generator v2.0 — Quick Start
# ============================================
# Usage: chmod +x start.sh && ./start.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║     🎬 Anime Edits Generator v2.0       ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ─── CHECK PREREQUISITES ─────────────────────────────

echo -e "${YELLOW}Checking prerequisites...${NC}"

# Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js not found. Install v18+: https://nodejs.org${NC}"
    exit 1
fi
echo -e "  ${GREEN}✅ Node.js $(node --version)${NC}"

# Python
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Python3 not found. Install 3.9+: https://python.org${NC}"
    exit 1
fi
echo -e "  ${GREEN}✅ Python $(python3 --version)${NC}"

# FFmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo -e "${RED}❌ FFmpeg not found. Install: brew install ffmpeg (mac) / apt install ffmpeg (linux)${NC}"
    exit 1
fi
echo -e "  ${GREEN}✅ FFmpeg found${NC}"

# ─── CHECK .env FILE ─────────────────────────────────

if [ ! -f "node-service/.env" ]; then
    echo ""
    echo -e "${YELLOW}⚠️  No .env file found!${NC}"
    echo -e "   Creating from template..."
    cp node-service/.env.example node-service/.env
    echo -e "${YELLOW}   → Edit node-service/.env and add your API keys!${NC}"
    echo -e "${YELLOW}   → Then re-run this script.${NC}"
    echo ""
    echo "   Required keys:"
    echo "     OPENAI_API_KEY or GEMINI_API_KEY  (for AI scripts)"
    echo "     PEXELS_API_KEY or PIXABAY_API_KEY (for images)"
    echo ""
    exit 0
fi

# ─── INSTALL DEPENDENCIES ────────────────────────────

echo ""
echo -e "${YELLOW}Installing dependencies...${NC}"

# Node deps
echo -e "  📦 Node.js packages..."
cd node-service && npm install --silent 2>/dev/null && cd ..

# Python deps
echo -e "  🐍 Python packages..."
cd python-tts-service && pip install -q -r requirements.txt 2>/dev/null && cd ..

echo -e "  ${GREEN}✅ Dependencies installed${NC}"

# ─── START SERVICES ──────────────────────────────────

echo ""
echo -e "${CYAN}Starting services...${NC}"

# Start Python TTS in background
echo -e "  🎤 Starting TTS service (port 5050)..."
cd python-tts-service && python3 app.py &
TTS_PID=$!
cd ..
sleep 2

# Start Node.js in background
echo -e "  🎬 Starting Node.js orchestrator (port 4000)..."
cd node-service && node server.js &
NODE_PID=$!
cd ..
sleep 2

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗"
echo -e "║         ✅ All services running!         ║"
echo -e "╠══════════════════════════════════════════╣"
echo -e "║  Backend:  http://localhost:4000         ║"
echo -e "║  TTS:      http://localhost:5050         ║"
echo -e "║  Frontend: Open frontend/index.html      ║"
echo -e "║                                          ║"
echo -e "║  Health:   http://localhost:4000/health   ║"
echo -e "╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "Press ${RED}Ctrl+C${NC} to stop all services"
echo ""

# Handle cleanup on exit
trap "echo ''; echo 'Stopping services...'; kill $TTS_PID $NODE_PID 2>/dev/null; echo 'Done.'; exit 0" INT TERM

# Wait for processes
wait
