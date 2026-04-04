# AMV Hotfix — FFmpeg expression errors

## What was wrong
Three invalid FFmpeg zoompan expressions:

1. zoom_pulse: `(on%17.8)/17.8)` — % needs integer operands, missing opening paren
   Fixed: `mod(on,17.80)/17.80`

2. breathe: `sin(on*2*PI*...)` — PI is not defined in FFmpeg's expression engine
   Fixed: `sin(on*2*3.14159265*...)`

3. pan_left/pan_right: x could go out of bounds
   Fixed: wrapped with min()/max() clamps

## Apply
cp node-service/services/amvGenerator.js /path/to/your/project/node-service/services/
# nodemon will auto-restart
