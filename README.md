
# AMV Feature — Setup & Usage

## New files
  node-service/server.js                  — adds /api/amv routes
  node-service/routes/amv.js              — upload, analyze, generate endpoints
  node-service/services/amvGenerator.js  — beat sync + FFmpeg pipeline
  python-tts-service/beat_detector.py    — librosa beat analysis service (port 5051)
  frontend/index.html                     — new UI with AMV Editor + AI Generator tabs

## Install & start

### 1. Beat detector (new service — port 5051)
  pip3 install librosa numpy flask flask-cors
  cd python-tts-service
  python3 beat_detector.py

### 2. TTS (existing — port 5050)
  python3 app.py

### 3. Node server (existing — port 4000)
  cd node-service
  npm run dev

### 4. Open frontend
  Open frontend/index.html in your browser

## How the AMV editor works
  1. Upload music → auto-detects BPM + beat timestamps via librosa
  2. Upload photos/videos → they get distributed across beats automatically
  3. Strong beats → zoom punch effect + hard cut transition
     Medium beats → zoom in + dissolve
     Weak beats   → slow pan + fade
  4. FFmpeg renders the final video with your music locked to the cuts
