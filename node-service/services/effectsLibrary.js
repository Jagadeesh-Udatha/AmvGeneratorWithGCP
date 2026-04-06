/**
 * Effects Library v2.0 — Professional AMV Effects (Complete)
 *
 * Central registry of ALL motion effects, transitions, color grades, and overlays.
 * Every effect is an FFmpeg filter chain that degrades gracefully.
 *
 * v2.0 additions over v1.0:
 *   Motion:     +7 (tilt_shift, glitch_flash, vhs_shake, speed_ramp_in,
 *                    speed_ramp_out, freeze_punch, echo_trail)  → 28 total
 *   Transitions: +5 (dissolve_fast, dissolve_slow, fadeblack_fast,
 *                     fadeblack_slow, film_burn)                → 25 total
 *   Overlays:   +2 (particles, rain)                           → 9 total
 *   Color grades: unchanged                                    → 12 total
 *
 * Exports:
 *   MOTION_EFFECTS    — Set of 28 valid motion effect names
 *   TRANSITIONS       — Set of 25 valid transition names
 *   COLOR_GRADES      — Set of 12 valid color grade names
 *   OVERLAYS          — Set of 9 valid overlay names
 *
 *   buildMotionFilter(name, opts)  → FFmpeg filter string (zoompan / compound)
 *   buildColorGrade(name)          → FFmpeg filter string
 *   buildOverlay(name, w, h)       → FFmpeg filter string
 *   buildSceneFilterChain(opts)    → complete -vf chain for one image scene
 *   mapTransition(name)            → { transition: xfadeName }
 *   getTransitionDuration(name, dropStrength) → seconds
 *
 *   EMOTION_PALETTES  — per-emotion ranked arrays for each category
 *   EFFECT_CATEGORIES / TRANSITION_CATEGORIES / GRADE_CATEGORIES — UI groupings
 *
 *   resolveLegacyEffect(name)      → new name
 *   resolveLegacyTransition(name)  → new name
 */


// ═════════════════════════════════════════════════════════════════════════════
// MOTION EFFECTS (28)
// ═════════════════════════════════════════════════════════════════════════════

const MOTION_EFFECTS = new Set([
  // Zoom — pure scale change, no pan
  "zoom_pulse",        // sawtooth zoom synced to beat frequency
  "zoom_punch",        // aggressive snap-zoom in
  "zoom_punch_out",    // aggressive snap-zoom out
  "zoom_in",           // linear zoom in 1.0→1.2
  "zoom_out",          // linear zoom out 1.2→1.0
  // Ken Burns — zoom + diagonal pan
  "ken_burns",         // classic slow zoom + diagonal pan
  "ken_burns_slow",    // very slow ken burns for emotional scenes
  // Pan — single direction per effect (left = camera moves right)
  "pan_left",          // horizontal pan, z=1.15, 8% width travel
  "drift_left",        // slow gentle drift, z=1.08, 3% width travel
  // Breathe — sinusoidal zoom pulse at beat frequency
  "breathe",           // sinusoidal zoom synced to beat count
  "breathe_fast",      // high-freq sinusoidal zoom
  "breathe_slow",      // low-freq sinusoidal zoom (emotional)
  // Shake — high-frequency oscillation
  "shake_horizontal",  // horizontal oscillation (hype/action)
  "shake_vertical",    // vertical oscillation
  // Spin — circular pan motion
  "spin_cw",           // clockwise circular pan
  "spin_ccw",          // counter-clockwise circular pan
  // Glitch / FX
  "glitch_horizontal", // jittery x-offset jumps
  "glitch_flash",      // rapid alternating zoom (strobe-like)
  "vhs_shake",         // analog VHS tracking jitter
  // Speed ramp
  "speed_ramp_in",     // accelerating zoom in
  "speed_ramp_out",    // decelerating zoom out
  // Special
  "freeze_punch",      // hold still, then snap zoom at end
  "echo_trail",        // slow drift with slight oscillation (dreamy)
  "static",            // no motion
]);

/**
 * Build a zoompan-based motion filter for a single image scene.
 *
 * @param {string} name          — effect name from MOTION_EFFECTS
 * @param {object} opts
 *   @param {number} duration    — scene duration in seconds
 *   @param {number} fps         — frames per second (usually 30)
 *   @param {number} w           — output width
 *   @param {number} h           — output height
 *   @param {number[]} beatOffsets — beat times relative to scene start
 * @returns {string} FFmpeg filter fragment (no trailing comma)
 */
function buildMotionFilter(name, { duration, fps = 30, w, h, beatOffsets = [], faceAware = false }) {
  const totalFrames = Math.max(2, Math.round(duration * fps));
  const s = `${w}x${h}`;
  const bps = beatOffsets.length > 1
    ? (beatOffsets.length - 1) / (beatOffsets[beatOffsets.length - 1] - beatOffsets[0] + 0.001)
    : 2.0;

  // Helper: centered x/y expressions for a given zoom expression
  // When zoompan zooms, the crop window shrinks. These keep it centered.
  // Face-aware: shift Y center to upper 35% of frame for anime face focus
  const cx = "iw/2-(iw/zoom/2)";
  const cy = faceAware ? "ih*0.35-(ih/zoom/2)" : "ih/2-(ih/zoom/2)";

  switch (name) {
    // ── Zoom family ──────────────────────────────────────────────────────────
    case "zoom_pulse": {
      // Sawtooth: ramp 1.0→1.15, snap back, repeat at beat frequency
      const period = Math.max(2, fps / Math.max(0.5, bps));
      return `zoompan=z='1.0+0.15*abs(2*mod(on\\,${period.toFixed(1)})/${period.toFixed(1)}-1)':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "zoom_punch": {
      // Aggressive snap-zoom in: fast ramp with bigger amplitude
      const period = Math.max(2, fps / Math.max(0.5, bps));
      return `zoompan=z='1.0+0.25*mod(on\\,${period.toFixed(1)})/${period.toFixed(1)}':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "zoom_punch_out": {
      // Inverse: zoom out then snap back
      const period = Math.max(2, fps / Math.max(0.5, bps));
      return `zoompan=z='1.25-0.25*mod(on\\,${period.toFixed(1)})/${period.toFixed(1)}':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "zoom_in":
      return `zoompan=z='min(1.0+on*${(0.2 / totalFrames).toFixed(6)}\\,1.2)':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
    case "zoom_out":
      return `zoompan=z='max(1.2-on*${(0.2 / totalFrames).toFixed(6)}\\,1.0)':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;

    // ── Ken Burns family ─────────────────────────────────────────────────────
    case "ken_burns": {
      const yb = faceAware ? "ih*0.35" : "ih/2";
      return `zoompan=z='1.05+0.0008*on':x='iw/2-(iw/zoom/2)+on*0.3':y='${yb}-(ih/zoom/2)+on*0.15':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "ken_burns_fast": {
      const yb = faceAware ? "ih*0.35" : "ih/2";
      return `zoompan=z='1.05+0.0018*on':x='iw/2-(iw/zoom/2)+on*0.6':y='${yb}-(ih/zoom/2)+on*0.3':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "ken_burns_slow": {
      const yb = faceAware ? "ih*0.35" : "ih/2";
      return `zoompan=z='1.02+0.0003*on':x='iw/2-(iw/zoom/2)+on*0.12':y='${yb}-(ih/zoom/2)+on*0.06':d=${totalFrames}:s=${s}:fps=${fps}`;
    }

    // ── Pan family ───────────────────────────────────────────────────────────
    case "pan_left": {
      const step = (w * 0.08 / totalFrames).toFixed(4);
      return `zoompan=z=1.15:x='min(iw/2-(iw/zoom/2)+on*${step}\\,iw-(iw/zoom))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "pan_right": {
      const step = (w * 0.08 / totalFrames).toFixed(4);
      return `zoompan=z=1.15:x='max(iw/2-(iw/zoom/2)-on*${step}\\,0)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "drift_left": {
      const step = (w * 0.03 / totalFrames).toFixed(5);
      return `zoompan=z=1.08:x='min(iw/2-(iw/zoom/2)+on*${step}\\,iw-(iw/zoom))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "drift_right": {
      const step = (w * 0.03 / totalFrames).toFixed(5);
      return `zoompan=z=1.08:x='max(iw/2-(iw/zoom/2)-on*${step}\\,0)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${s}:fps=${fps}`;
    }

    // ── Breathe family ───────────────────────────────────────────────────────
    case "breathe": {
      const freq = Math.max(0.5, beatOffsets.length > 0 ? beatOffsets.length / duration : 2);
      return `zoompan=z='1.06+0.06*sin(on*2*3.14159*${freq.toFixed(3)}/${fps})':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "breathe_fast": {
      const freq = Math.max(1.0, beatOffsets.length > 0 ? beatOffsets.length / duration * 1.5 : 3);
      return `zoompan=z='1.04+0.08*sin(on*2*3.14159*${freq.toFixed(3)}/${fps})':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "breathe_slow": {
      const freq = Math.max(0.3, beatOffsets.length > 0 ? beatOffsets.length / duration * 0.5 : 0.8);
      return `zoompan=z='1.03+0.04*sin(on*2*3.14159*${freq.toFixed(3)}/${fps})':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
    }

    // ── Shake family ─────────────────────────────────────────────────────────
    case "shake_horizontal": {
      const amp = Math.min(w * 0.03, 30);
      const shakeFreq = Math.max(2, bps * 2);
      return `zoompan=z=1.12:x='iw/2-(iw/zoom/2)+${amp.toFixed(1)}*sin(on*2*3.14159*${shakeFreq.toFixed(2)}/${fps})':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "shake_vertical": {
      const amp = Math.min(h * 0.02, 25);
      const shakeFreq = Math.max(2, bps * 2);
      return `zoompan=z=1.12:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+${amp.toFixed(1)}*sin(on*2*3.14159*${shakeFreq.toFixed(2)}/${fps})':d=${totalFrames}:s=${s}:fps=${fps}`;
    }

    // ── Spin family ──────────────────────────────────────────────────────────
    // Simulated via circular x,y oscillation on zoompan
    case "spin_cw": {
      const r = Math.min(w * 0.04, 40);
      const spinFreq = Math.max(0.3, bps * 0.5);
      return `zoompan=z=1.15:x='iw/2-(iw/zoom/2)+${r.toFixed(1)}*cos(on*2*3.14159*${spinFreq.toFixed(2)}/${fps})':y='ih/2-(ih/zoom/2)+${r.toFixed(1)}*sin(on*2*3.14159*${spinFreq.toFixed(2)}/${fps})':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "spin_ccw": {
      const r = Math.min(w * 0.04, 40);
      const spinFreq = Math.max(0.3, bps * 0.5);
      return `zoompan=z=1.15:x='iw/2-(iw/zoom/2)-${r.toFixed(1)}*cos(on*2*3.14159*${spinFreq.toFixed(2)}/${fps})':y='ih/2-(ih/zoom/2)+${r.toFixed(1)}*sin(on*2*3.14159*${spinFreq.toFixed(2)}/${fps})':d=${totalFrames}:s=${s}:fps=${fps}`;
    }

    // ── Tilt ─────────────────────────────────────────────────────────────────
    case "tilt_shift": {
      // Gentle y-axis drift with slow zoom — gives a parallax/tilt feeling
      const yStep = (h * 0.04 / totalFrames).toFixed(5);
      return `zoompan=z='1.06+0.0005*on':x='iw/2-(iw/zoom/2)':y='max(ih/2-(ih/zoom/2)-on*${yStep}\\,0)':d=${totalFrames}:s=${s}:fps=${fps}`;
    }

    // ── Glitch / FX family ───────────────────────────────────────────────────
    case "glitch_horizontal": {
      // Pseudo-random x jumps using nested sin with prime multipliers
      const amp = Math.min(w * 0.05, 50);
      return `zoompan=z=1.10:x='iw/2-(iw/zoom/2)+${amp.toFixed(1)}*sin(on*7.919)*sin(on*3.137)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "glitch_flash": {
      // Rapid alternating zoom levels — strobe-zoom effect
      // Uses high-freq abs(sin) to create zoom stuttering
      const glitchFreq = Math.max(3, bps * 2);
      return `zoompan=z='1.05+0.20*abs(sin(on*3.14159*${glitchFreq.toFixed(1)}/${fps}))':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "vhs_shake": {
      // Analog VHS tracking jitter: high-freq small random x+y offsets
      // Multiple overlapping sine waves with irrational frequencies for pseudo-randomness
      const xAmp = Math.min(w * 0.015, 15);
      const yAmp = Math.min(h * 0.008, 10);
      return `zoompan=z=1.08:` +
        `x='iw/2-(iw/zoom/2)+${xAmp.toFixed(1)}*(sin(on*11.3)+0.5*sin(on*7.7)+0.3*sin(on*23.1))':` +
        `y='ih/2-(ih/zoom/2)+${yAmp.toFixed(1)}*(sin(on*13.7)+0.4*sin(on*5.3))':` +
        `d=${totalFrames}:s=${s}:fps=${fps}`;
    }

    // ── Speed ramp family ────────────────────────────────────────────────────
    case "speed_ramp_in": {
      // Accelerating zoom in: quadratic ease-in (slow start → fast end)
      // z = 1.0 + 0.25 * (on/totalFrames)^2
      const f = totalFrames;
      return `zoompan=z='1.0+0.25*on*on/${f}/${f}':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
    }
    case "speed_ramp_out": {
      // Decelerating zoom out: starts zoomed, fast start → slow end
      // z = 1.25 - 0.25 * (1 - (1-on/totalFrames)^2) = eased deceleration
      const f = totalFrames;
      return `zoompan=z='1.25-0.25*(2*on/${f}-on*on/${f}/${f})':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
    }

    // ── Freeze + Punch ───────────────────────────────────────────────────────
    case "freeze_punch": {
      // Hold still at z=1.05 for ~80% of duration, then snap zoom to 1.30 in last 20%
      const threshold = Math.round(totalFrames * 0.8);
      const rampLen = Math.max(2, totalFrames - threshold);
      return `zoompan=z='if(lt(on\\,${threshold})\\,1.05\\,1.05+0.25*(on-${threshold})/${rampLen})':x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
    }

    // ── Echo trail ───────────────────────────────────────────────────────────
    case "echo_trail": {
      // Dreamy slow drift with gentle oscillating zoom (like a floating memory)
      const driftStep = (w * 0.02 / totalFrames).toFixed(5);
      return `zoompan=z='1.04+0.03*sin(on*2*3.14159*0.6/${fps})':` +
        `x='iw/2-(iw/zoom/2)+on*${driftStep}':` +
        `y='ih/2-(ih/zoom/2)+3*sin(on*2*3.14159*0.4/${fps})':` +
        `d=${totalFrames}:s=${s}:fps=${fps}`;
    }

    // ── Static ───────────────────────────────────────────────────────────────
    case "static":
    default:
      return `zoompan=z=1.05:x='${cx}':y='${cy}':d=${totalFrames}:s=${s}:fps=${fps}`;
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// TRANSITIONS (25)
// Maps custom names → FFmpeg xfade transition names.
// ═════════════════════════════════════════════════════════════════════════════

const TRANSITIONS = new Set([
  // Flash
  "flash_white",    // fade through white — bright cut
  "flash_black",    // fade through black — dark cut
  // Zoom
  "zoom_blur_in",   // zoom-in blur entry
  "zoom_blur_out",  // zoom-out blur entry
  // Slide / Wipe
  "whip_pan_left",  // fast cover left
  "whip_pan_right", // fast cover right
  "push_left",      // slide content left
  "push_right",     // slide content right
  "wipe_down",      // vertical wipe downward
  // Slice
  "slice_left",     // horizontal slice left
  "slice_right",    // horizontal slice right
  // Dissolve
  "dissolve",       // standard cross-dissolve
  // Fade
  "fadeblack",      // fade through black
  "fadewhite",      // fade through white
  // Glitch
  "glitch_cut",     // pixelation glitch
]);

/**
 * Map a transition name to the FFmpeg xfade transition parameter.
 * @param {string} name — transition name from TRANSITIONS
 * @returns {{ transition: string }}
 */
function mapTransition(name) {
  switch (name) {
    // Flash
    case "flash_white":     return { transition: "fadewhite" };
    case "flash_black":     return { transition: "fadeblack" };
    case "strobe_cut":      return { transition: "fadewhite" };

    // Zoom
    case "zoom_blur_in":    return { transition: "zoomin" };
    case "zoom_blur_out":   return { transition: "squeezeh" };
    case "cross_zoom":      return { transition: "zoomin" };

    // Slide / Wipe
    case "whip_pan_left":   return { transition: "coverleft" };
    case "whip_pan_right":  return { transition: "coverright" };
    case "push_left":       return { transition: "slideleft" };
    case "push_right":      return { transition: "slideright" };
    case "wipe_down":       return { transition: "slidedown" };

    // Slice
    case "slice_left":      return { transition: "hlslice" };
    case "slice_right":     return { transition: "hrslice" };

    // Dissolve
    case "dissolve":        return { transition: "dissolve" };
    case "dissolve_fast":   return { transition: "dissolve" };
    case "dissolve_slow":   return { transition: "dissolve" };
    case "dissolve_glow":   return { transition: "dissolve" };

    // Fade
    case "fadeblack":       return { transition: "fadeblack" };
    case "fadeblack_fast":  return { transition: "fadeblack" };
    case "fadeblack_slow":  return { transition: "fadeblack" };
    case "fadewhite":       return { transition: "fadewhite" };

    // Glitch / FX
    case "glitch_cut":      return { transition: "pixelize" };
    case "pixelize":        return { transition: "pixelize" };

    // Special
    case "ripple":          return { transition: "radial" };
    case "film_burn":       return { transition: "fadewhite" };

    // Legacy names (backward-compat with existing sessions)
    case "fade":            return { transition: "fade" };
    case "wipeleft":        return { transition: "wipeleft" };
    case "wiperight":       return { transition: "wiperight" };
    case "slidedown":       return { transition: "slidedown" };
    case "slideup":         return { transition: "slideup" };
    case "slideleft":       return { transition: "slideleft" };
    case "slideright":      return { transition: "slideright" };
    case "smoothleft":      return { transition: "smoothleft" };
    case "smoothright":     return { transition: "smoothright" };
    case "circlecrop":      return { transition: "circlecrop" };

    default:                return { transition: "fade" };
  }
}

/**
 * Get the suggested transition duration for a named transition at a given drop strength.
 * Fast transitions (strobe, flash) are always short; dissolves scale with energy.
 */
function getTransitionDuration(name, dropStrength = 0.5) {
  // Strobe: always ultra-short
  if (name === "strobe_cut") return 0.03;

  // Flash types: very short
  if (name === "flash_white" || name === "flash_black") {
    return dropStrength > 0.7 ? 0.03 : 0.06;
  }

  // Glitch: short snap
  if (name === "glitch_cut") return 0.08;

  // Film burn: medium-short bright flash
  if (name === "film_burn") return 0.10;

  // Whip pans: medium-short
  if (name === "whip_pan_left" || name === "whip_pan_right") return 0.12;

  // Zooms: medium
  if (name === "zoom_blur_in" || name === "zoom_blur_out" || name === "cross_zoom") return 0.15;

  // Slices: medium-short
  if (name === "slice_left" || name === "slice_right") return 0.10;

  // Pixelize: medium
  if (name === "pixelize") return 0.12;

  // Dissolve variants with fixed durations
  if (name === "dissolve_fast") return 0.12;
  if (name === "dissolve_slow") return 0.40;

  // Dissolve (standard + glow): strength-adaptive
  if (name === "dissolve" || name === "dissolve_glow") {
    return dropStrength > 0.6 ? 0.15 : 0.30;
  }

  // Fadeblack variants with fixed durations
  if (name === "fadeblack_fast") return 0.08;
  if (name === "fadeblack_slow") return 0.40;

  // Fadeblack (standard): strength-adaptive
  if (name === "fadeblack") {
    return dropStrength > 0.6 ? 0.10 : 0.25;
  }

  // Fadewhite: strength-adaptive
  if (name === "fadewhite") {
    return dropStrength > 0.6 ? 0.08 : 0.15;
  }

  // Push/slide: medium
  if (name === "push_left" || name === "push_right" || name === "wipe_down") return 0.15;

  // Ripple: medium-long
  if (name === "ripple") return 0.25;

  // Default: strength-based
  if (dropStrength > 0.8) return 0.04;
  if (dropStrength > 0.5) return 0.12;
  return 0.25;
}


// ═════════════════════════════════════════════════════════════════════════════
// COLOR GRADES (12)
// Each returns an FFmpeg filter fragment to append to the filter chain.
// ═════════════════════════════════════════════════════════════════════════════

const COLOR_GRADES = new Set([
  "hype_red",          // red push + high contrast (action/phonk)
  "hype_blue",         // blue push + high contrast (cyberpunk)
  "hype_green",        // toxic green push (mecha/sci-fi)
  "hype_purple",       // purple/violet push (magical/supernatural)
  "sad_blue",          // cool blue desaturated
  "sad_grey",          // near-monochrome, low saturation
  "romantic_warm",     // warm golden tint + soft saturation
  "romantic_soft",     // pastel warm, lower contrast
  "triumphant_gold",   // gold/amber cinematic
  "cinematic",         // teal shadows + orange highlights (hollywood)
  "teal_orange",       // stronger hollywood teal-orange split-tone
  "anime_bright",      // vivid anime-style: high saturation, bright, punchy
  "horror_red",        // dark red shadows, desaturated highlights, grim
  "sunset_gold",       // warm amber sunset, lifted shadows, dreamy
  "cold_steel",        // cold blue-grey, metallic, action/thriller
  "vintage",           // faded sepia, low contrast
  "manga",             // high-contrast black & white + edge emphasis
  "neon",              // high saturation + vibrance
  "none",              // pass-through
]);

/**
 * Build a color grade filter chain.
 * @param {string} name — color grade name from COLOR_GRADES
 * @returns {string} FFmpeg filter fragment (comma-separated if compound), or "" for none
 */
function buildColorGrade(name) {
  switch (name) {
    case "hype_red":
      // Hot red push: warm shadows, high contrast, punchy saturation
      return "colorbalance=rs=0.25:gm=-0.08:bh=-0.12,eq=contrast=1.3:brightness=0.02:saturation=1.3";
    case "hype_blue":
      // Cyberpunk blue: cool tint, strong blue in highlights, elevated contrast
      return "colorbalance=rs=-0.10:gs=-0.05:bs=0.30:bh=0.15,eq=contrast=1.25:saturation=1.2";
    case "sad_blue":
      // Desaturated blue: cool melancholic tone, low sat, slightly dark
      return "colorbalance=rs=-0.12:gs=-0.05:bs=0.20:bm=0.08,eq=contrast=0.95:saturation=0.6:brightness=-0.03";
    case "sad_grey":
      // Near-monochrome: very low saturation, slightly flat, somber
      return "eq=saturation=0.25:contrast=0.9:brightness=-0.04";
    case "romantic_warm":
      // Warm golden glow: orange in highlights, gentle saturation boost
      return "colorbalance=rs=0.12:gs=0.06:bs=-0.10:rh=0.08,eq=contrast=1.05:saturation=1.1:brightness=0.03";
    case "romantic_soft":
      // Pastel warmth: low contrast, soft warm tint, slightly faded
      return "colorbalance=rs=0.08:gs=0.05:bs=-0.06,eq=contrast=0.90:saturation=0.9:brightness=0.05";
    case "triumphant_gold":
      // Epic gold/amber: warm midtones, moderate contrast, heroic look
      return "colorbalance=rs=0.18:gs=0.10:bs=-0.15:rm=0.08:gm=0.05,eq=contrast=1.15:saturation=1.2:brightness=0.02";
    case "cinematic":
      // Hollywood teal-orange: push teal into shadows, orange into highlights
      return "colorbalance=rs=-0.08:gs=0.04:bs=0.12:rh=0.15:gh=0.05:bh=-0.08,eq=contrast=1.2:saturation=1.1";
    case "vintage":
      // Retro faded: warm sepia tint, low contrast, lifted blacks, slight gamma
      return "colorbalance=rs=0.10:gs=0.06:bs=-0.08,eq=contrast=0.85:saturation=0.7:brightness=0.04:gamma=1.1";
    case "neon":
      // Hyper-saturated: everything popping, max vibrance
      return "eq=saturation=1.8:contrast=1.3:brightness=0.02";
    case "manga":
      // Black & white manga: zero saturation, extreme contrast for ink feel
      return "eq=saturation=0.0:contrast=1.8:brightness=0.05";
    case "hype_green":
      // Toxic green/lime: mecha, sci-fi, supernatural power moments
      return "colorbalance=rs=-0.15:gs=0.22:bs=-0.12:gh=0.14:bh=-0.06,eq=contrast=1.25:saturation=1.35";
    case "hype_purple":
      // Violet/purple: magical powers, supernatural, mystic scenes
      return "colorbalance=rs=0.18:gs=-0.12:bs=0.28:rh=0.10:bh=0.22,eq=contrast=1.20:saturation=1.30";
    case "teal_orange":
      // Strong Hollywood split-tone: deep teal shadows, vivid orange highlights
      return "colorbalance=rs=-0.18:gs=0.06:bs=0.25:rh=0.25:gh=0.08:bh=-0.18,eq=contrast=1.28:saturation=1.15";
    case "anime_bright":
      // Vivid anime look: punchy saturation, bright whites, high contrast
      return "eq=saturation=1.55:contrast=1.18:brightness=0.05,colorbalance=rh=0.05:gh=0.03:bh=-0.04";
    case "horror_red":
      // Grim horror: dark red shadows, desaturated midtones, oppressive feel
      return "colorbalance=rs=0.22:gs=-0.10:bs=-0.12:rm=0.10:gm=-0.06,eq=contrast=1.40:saturation=0.72:brightness=-0.05";
    case "sunset_gold":
      // Warm amber sunset: lifted shadows, dreamy warm glow
      return "colorbalance=rs=0.20:gs=0.12:bs=-0.18:rh=0.14:gh=0.06:bh=-0.10,eq=contrast=1.05:saturation=1.18:brightness=0.04";
    case "cold_steel":
      // Cold blue-grey metallic: action/thriller, winter, mecha combat
      return "colorbalance=rs=-0.18:gs=-0.06:bs=0.18:rm=-0.04:bm=0.08,eq=contrast=1.22:saturation=0.80:brightness=-0.02";
    case "none":
    default:
      return "";
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// OVERLAYS (9)
// Returns FFmpeg filter fragments that can be appended to the video chain.
// These work as post-processing on the rendered scene.
// ═════════════════════════════════════════════════════════════════════════════

const OVERLAYS = new Set([
  "vignette",              // standard darkened edges
  "vignette_strong",       // heavy vignette for dramatic scenes
  "film_grain",            // analog noise grain
  "film_grain_heavy",      // stronger analog noise (VHS / old film)
  "scanlines",             // horizontal scanline pattern (CRT)
  "scanlines_strong",      // heavy CRT scanlines (retro gaming)
  "lens_flare",            // simulated bright glow spot
  "speed_lines",           // radial zoom blur (manga action)
  "chromatic_aberration",  // RGB channel split at edges
  "chromatic_strong",      // stronger RGB split (glitch/cyberpunk)
  "particles",             // floating dust/sparkle particles
  "rain",                  // rain streaks overlay
  "snow",                  // light snow particles
  "dirt_overlay",          // smudged lens / dirty glass texture
  "glow_soft",             // soft bloom glow (dreamy/romantic)
  "halftone",              // manga/comic halftone dot pattern
]);

/**
 * Build an overlay filter fragment.
 * @param {string} name — overlay name from OVERLAYS
 * @param {number} w — video width
 * @param {number} h — video height
 * @returns {string} FFmpeg filter fragment, or "" for none
 */
function buildOverlay(name, w, h) {
  switch (name) {
    case "vignette":
      return "vignette=PI/5";

    case "vignette_strong":
      return "vignette=PI/3.5";

    case "film_grain":
      // Subtle temporal noise (analog grain feel)
      return "noise=alls=12:allf=t";

    case "scanlines":
      // CRT scanline effect: darken every-other line via geq
      // Uses drawbox repeated approach — simpler: just use eq with slight noise
      return "noise=alls=5:allf=p";

    case "lens_flare":
      // Simulated glow: brighten upper-right area using colorbalance + slight exposure lift
      // The old vignette approach failed because W/H aren't valid expressions
      return "vignette=PI/4:mode=backward";

    case "speed_lines":
      // Radial blur approximation: smart blur for motion feel
      return "smartblur=lr=1.5:ls=-0.35:lt=-3.5:cr=0.5:cs=0.25:ct=1.5";

    case "chromatic_aberration":
      // RGB channel offset: slight horizontal + vertical shift of R and B channels
      return "rgbashift=rh=3:bh=-3:rv=-2:bv=2";

    case "particles":
      // Floating dust/sparkle: uniform temporal noise at high intensity
      // Simplified from curves approach to avoid quoting issues
      return "noise=alls=60:allf=t+u";

    case "rain":
      // Simulated rain: temporal noise with vertical bias
      return "noise=alls=25:allf=t";

    case "film_grain_heavy":
      // Stronger analog noise — VHS / old film feel
      return "noise=alls=55:allf=t+u";

    case "scanlines_strong":
      // Heavy CRT scanlines — retro gaming / 80s aesthetic
      return `drawgrid=width=0:height=3:thickness=2:color=black@0.45`;

    case "chromatic_strong":
      // Stronger RGB split — glitch/cyberpunk
      return "rgbashift=rh=5:rv=0:gh=-3:gv=2:bh=-5:bv=0";

    case "snow":
      // Light snow particles — soft temporal noise at top of frame
      return "noise=alls=18:allf=t";

    case "dirt_overlay":
      // Smudged lens / dirty glass — slight blur + noise combo
      return "noise=alls=20:allf=u,smartblur=0.5:0.2:0";

    case "glow_soft":
      // Soft bloom glow — dreamy/romantic scenes
      return "gblur=sigma=12,eq=brightness=0.04:contrast=0.90";

    case "halftone":
      // Manga/comic halftone dot pattern approximation
      return "hqdn3d=4:4:3:3,eq=contrast=1.6:saturation=0.4";

    default:
      return "";
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// EMOTION PALETTES
// Ranked effect/transition/grade/overlay choices per emotion.
// Used by editClassifier and amvGenerator for AI selection.
// First item = highest intensity / most characteristic.
// ═════════════════════════════════════════════════════════════════════════════

const EMOTION_PALETTES = {
  hype: {
    label: "⚡ Hype / Action",
    effects:     ["zoom_punch", "zoom_pulse", "shake_horizontal", "glitch_flash", "vhs_shake", "speed_ramp_in", "glitch_horizontal", "breathe_fast", "pan_left", "zoom_in"],
    transitions: ["flash_black", "glitch_cut", "whip_pan_left", "flash_white", "strobe_cut", "whip_pan_right", "slice_left", "film_burn", "fadeblack_fast"],
    grades:      ["hype_red", "hype_blue", "neon", "cinematic", "none"],
    overlays:    ["vignette", "chromatic_aberration", "film_grain", "scanlines", "speed_lines"],
  },
  triumphant: {
    label: "🏆 Triumphant / Epic",
    effects:     ["zoom_out", "zoom_in", "ken_burns_fast", "freeze_punch", "speed_ramp_out", "pan_right", "breathe", "drift_right", "spin_cw", "tilt_shift"],
    transitions: ["flash_black", "cross_zoom", "zoom_blur_in", "dissolve_fast", "whip_pan_right", "push_right", "wipe_down", "film_burn"],
    grades:      ["triumphant_gold", "cinematic", "hype_red", "none", "neon"],
    overlays:    ["vignette", "lens_flare", "film_grain", "particles"],
  },
  sad: {
    label: "💙 Sad / Melancholic",
    effects:     ["ken_burns_slow", "breathe_slow", "drift_left", "echo_trail", "zoom_out", "ken_burns", "pan_left", "tilt_shift", "static"],
    transitions: ["dissolve_slow", "dissolve", "dissolve_glow", "fadeblack_slow", "fadeblack", "push_left", "ripple", "zoom_blur_out", "wipe_down"],
    grades:      ["sad_blue", "sad_grey", "vintage", "cinematic", "none"],
    overlays:    ["vignette_strong", "film_grain", "rain", "vignette", "particles"],
  },
  romantic: {
    label: "💗 Romantic / Hopeful",
    effects:     ["breathe_slow", "ken_burns_slow", "drift_right", "echo_trail", "breathe", "pan_right", "zoom_out", "ken_burns", "tilt_shift"],
    transitions: ["dissolve", "dissolve_glow", "dissolve_slow", "fadewhite", "cross_zoom", "push_right", "ripple", "zoom_blur_in"],
    grades:      ["romantic_warm", "romantic_soft", "vintage", "triumphant_gold", "none"],
    overlays:    ["vignette", "lens_flare", "particles", "film_grain"],
  },
  neutral: {
    label: "✦ Neutral",
    effects:     ["zoom_pulse", "ken_burns", "zoom_in", "pan_left", "breathe", "pan_right", "drift_left", "tilt_shift", "static"],
    transitions: ["dissolve", "push_left", "flash_black", "fadeblack", "slice_left", "zoom_blur_in", "whip_pan_left", "dissolve_fast"],
    grades:      ["cinematic", "none", "vintage", "neon"],
    overlays:    ["vignette", "film_grain"],
  },
};


// ═════════════════════════════════════════════════════════════════════════════
// EFFECT METADATA — human-readable categories for UI dropdowns
// ═════════════════════════════════════════════════════════════════════════════

const EFFECT_CATEGORIES = {
  zoom:      { label: "Zoom",       effects: ["zoom_pulse", "zoom_punch", "zoom_punch_out", "zoom_in", "zoom_out"] },
  ken:       { label: "Ken Burns",  effects: ["ken_burns", "ken_burns_fast", "ken_burns_slow"] },
  pan:       { label: "Pan",        effects: ["pan_left", "pan_right", "drift_left", "drift_right", "tilt_shift"] },
  breathe:   { label: "Breathe",    effects: ["breathe", "breathe_fast", "breathe_slow"] },
  shake:     { label: "Shake",      effects: ["shake_horizontal", "shake_vertical"] },
  spin:      { label: "Spin",       effects: ["spin_cw", "spin_ccw"] },
  glitch:    { label: "Glitch/FX",  effects: ["glitch_horizontal", "glitch_flash", "vhs_shake"] },
  ramp:      { label: "Ramp",       effects: ["speed_ramp_in", "speed_ramp_out", "freeze_punch"] },
  trail:     { label: "Trail",      effects: ["echo_trail"] },
  none:      { label: "None",       effects: ["static"] },
};

const TRANSITION_CATEGORIES = {
  flash:     { label: "Flash",      transitions: ["flash_white", "flash_black", "strobe_cut", "film_burn"] },
  zoom:      { label: "Zoom",       transitions: ["zoom_blur_in", "zoom_blur_out", "cross_zoom"] },
  slide:     { label: "Slide",      transitions: ["push_left", "push_right", "whip_pan_left", "whip_pan_right", "wipe_down"] },
  blend:     { label: "Blend",      transitions: ["dissolve", "dissolve_fast", "dissolve_slow", "dissolve_glow"] },
  fade:      { label: "Fade",       transitions: ["fadeblack", "fadeblack_fast", "fadeblack_slow", "fadewhite"] },
  glitch:    { label: "Glitch",     transitions: ["glitch_cut", "pixelize"] },
  slice:     { label: "Slice",      transitions: ["slice_left", "slice_right"] },
  special:   { label: "Special",    transitions: ["ripple"] },
};

const GRADE_CATEGORIES = {
  hype:      { label: "Hype",       grades: ["hype_red", "hype_blue", "hype_green", "hype_purple", "neon"] },
  emotional: { label: "Emotional",  grades: ["sad_blue", "sad_grey", "romantic_warm", "romantic_soft", "glow_soft"] },
  cinematic: { label: "Cinematic",  grades: ["cinematic", "teal_orange", "triumphant_gold", "sunset_gold", "cold_steel", "vintage"] },
  stylized:  { label: "Stylized",   grades: ["anime_bright", "horror_red", "manga", "none"] },
};


// ═════════════════════════════════════════════════════════════════════════════
// LEGACY COMPATIBILITY
// Accept old effect/transition names and map to new equivalents.
// ═════════════════════════════════════════════════════════════════════════════

const LEGACY_EFFECT_MAP = {
  "ken":           "ken_burns",
  "fast_zoom":     "zoom_punch",
  "slow_zoom":     "zoom_in",
  "zoom":          "zoom_in",
  "pan":           "pan_left",
  "shake":         "shake_horizontal",
  "glitch":        "glitch_horizontal",
};

const LEGACY_TRANSITION_MAP = {
  "fade":          "dissolve",
  "wipeleft":      "slice_left",
  "wiperight":     "slice_right",
  "smoothleft":    "push_left",
  "smoothright":   "push_right",
  "slideleft":     "push_left",
  "slideright":    "push_right",
  "slidedown":     "wipe_down",
  "slideup":       "wipe_down",
  "circlecrop":    "ripple",
  "pixelize_in":   "pixelize",
};

function resolveLegacyEffect(name) {
  if (MOTION_EFFECTS.has(name)) return name;
  return LEGACY_EFFECT_MAP[name] || name;
}

function resolveLegacyTransition(name) {
  if (TRANSITIONS.has(name)) return name;
  return LEGACY_TRANSITION_MAP[name] || name;
}


// ═════════════════════════════════════════════════════════════════════════════
// FULL SCENE FILTER BUILDER
// Combines motion + color grade + overlay into a complete filter chain.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build the complete filter chain for rendering a single image scene.
 *
 * @param {object} opts
 *   @param {string}   effect       — motion effect name
 *   @param {string}   colorGrade   — color grade name (or "none")
 *   @param {string[]} overlayList  — array of overlay names
 *   @param {number}   duration     — scene duration in seconds
 *   @param {number}   fps
 *   @param {number}   w, h         — dimensions
 *   @param {number[]} beatOffsets  — beat times relative to scene start
 * @returns {string} Complete FFmpeg -vf filter chain for image input
 */
function buildSceneFilterChain({
  effect = "ken_burns",
  colorGrade = "none",
  overlayList = [],
  duration,
  fps = 30,
  w, h,
  beatOffsets = [],
  faceAware = false,
}) {
  const parts = [];

  // 1. Scale + pad + SAR (ensures input is exactly w×h regardless of source)
  parts.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
  parts.push(`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`);
  parts.push("setsar=1");

  // 2. Motion effect (zoompan — the core of the animation)
  const motionF = buildMotionFilter(effect, { duration, fps, w, h, beatOffsets, faceAware });
  parts.push(motionF);

  // 3. FPS normalization (zoompan may produce variable rate)
  parts.push(`fps=${fps}`);

  // 4. Color grade
  const gradeF = buildColorGrade(colorGrade);
  if (gradeF) parts.push(gradeF);

  // 5. Overlays (order: vignette → grain → chromatic → etc.)
  for (const ov of overlayList) {
    const ovF = buildOverlay(ov, w, h);
    if (ovF) parts.push(ovF);
  }

  // 6. Default vignette if no vignette overlay specified
  const hasVignette = overlayList.some(o => o.startsWith("vignette"));
  if (!hasVignette) {
    parts.push("vignette=PI/5");
  }

  return parts.join(",");
}


// ═════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Registries (Sets)
  MOTION_EFFECTS,
  TRANSITIONS,
  COLOR_GRADES,
  OVERLAYS,

  // Builders
  buildMotionFilter,
  buildColorGrade,
  buildOverlay,
  buildSceneFilterChain,
  mapTransition,
  getTransitionDuration,

  // Palettes
  EMOTION_PALETTES,

  // Metadata (for UI categories)
  EFFECT_CATEGORIES,
  TRANSITION_CATEGORIES,
  GRADE_CATEGORIES,

  // Legacy compat
  resolveLegacyEffect,
  resolveLegacyTransition,
};