/**
 * Database Module v2.0 — SQLite for Anime Edit Studio
 *
 * Uses better-sqlite3 (synchronous, zero-config, single-file).
 *
 * NEW IN v2.0:
 *   - render_jobs table        — job queue (pending/processing/done/failed)
 *   - render_cache table       — hash-keyed cache: (imageHash+settings) → clipPath
 *   - compositions table       — DB-driven composition marketplace (admin/user submittable)
 *   - composition_votes table  — community upvotes on compositions
 *   - user_preferences table   — per-user saved preferences
 *   - All original tables preserved and extended
 *
 * ARCHITECTURE: This SQLite DB is the single source of truth for:
 *   1. Job queue state (render_jobs) — allows multiple workers to pick up jobs
 *   2. Scene render cache (render_cache) — avoids re-rendering identical inputs
 *   3. Composition library (compositions) — extensible without code deploys
 *   4. Session metadata, scene edits, training data (legacy tables extended)
 */

const path = require("path");
const fs   = require("fs");

const DB_PATH = path.join(__dirname, "..", "data", "anime_edit_studio.db");
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let _db = null;

function getDb() {
  if (_db) return _db;
  try {
    const Database = require("better-sqlite3");
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    _db.pragma("cache_size = -32000"); // 32MB page cache
    _initTables(_db);
    console.log(`   💾 SQLite database: ${DB_PATH}`);
    return _db;
  } catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
      console.log("   ⚠️  better-sqlite3 not installed — database disabled");
      console.log("      Run: npm install better-sqlite3");
    } else {
      console.error("   ❌ SQLite error:", e.message);
    }
    return null;
  }
}

function _initTables(db) {
  db.exec(`
    -- ─── SESSIONS ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      audio_file        TEXT,
      bpm               REAL,
      scene_count       INTEGER DEFAULT 0,
      total_duration    REAL DEFAULT 0,
      aspect_ratio      TEXT DEFAULT '9:16',
      export_path       TEXT,
      exported_at       INTEGER,
      user_rating       INTEGER,
      emotion_summary   TEXT,
      notes             TEXT,
      job_id            TEXT,        -- links to render_jobs
      status            TEXT DEFAULT 'ready'  -- ready|exporting|done
    );

    -- ─── SCENES ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS scenes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      scene_index       INTEGER NOT NULL,
      start_time        REAL,
      duration          REAL,
      emotion           TEXT,
      composition       TEXT,
      llm_reasoning     TEXT,
      edit_source       TEXT DEFAULT 'patterns',
      -- AI suggestions
      suggested_effect       TEXT,
      suggested_transition   TEXT,
      suggested_color_grade  TEXT,
      suggested_overlays     TEXT,
      -- Final values (after user edits)
      final_effect           TEXT,
      final_transition       TEXT,
      final_color_grade      TEXT,
      final_overlays         TEXT,
      -- Edit tracking
      was_edited        INTEGER DEFAULT 0,
      edited_at         INTEGER,
      edit_count        INTEGER DEFAULT 0,
      -- Cache key
      render_cache_key  TEXT,
      -- Audio features
      beat_alignment    REAL,
      energy            REAL,
      onset             REAL,
      centroid          REAL,
      segment_bpm       REAL,
      drop_strength     REAL,
      -- Visual features
      mean_brightness       REAL,
      brightness_variance   REAL,
      dominant_hue          REAL,
      saturation            REAL,
      color_temperature     REAL,
      edge_density          REAL,
      face_present          INTEGER,
      dark_scene            INTEGER,
      action_scene          INTEGER,
      contrast              REAL,
      warm_dominant         INTEGER,
      -- Stutter cut
      is_stutter_cut    INTEGER DEFAULT 0,
      stutter_type      TEXT,
      -- Media
      media_path        TEXT,
      clip_path         TEXT,
      thumb_path        TEXT,
      UNIQUE(session_id, scene_index)
    );

    -- ─── RENDER JOBS (queue) ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS render_jobs (
      id                TEXT PRIMARY KEY,
      session_id        TEXT,
      job_type          TEXT NOT NULL,  -- 'prepare'|'rerender'|'export'
      status            TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed|cancelled
      priority          INTEGER DEFAULT 5,   -- 1=highest, 10=lowest
      scene_index       INTEGER,             -- for rerender jobs
      total_scenes      INTEGER DEFAULT 0,
      scenes_done       INTEGER DEFAULT 0,
      params_json       TEXT,                -- full job params as JSON
      result_json       TEXT,                -- result after completion
      error_message     TEXT,
      worker_id         TEXT,                -- which worker picked this up
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      started_at        INTEGER,
      completed_at      INTEGER,
      progress_pct      INTEGER DEFAULT 0,
      progress_label    TEXT DEFAULT 'Queued'
    );

    -- ─── RENDER CACHE ────────────────────────────────────────────────────────
    -- Key = sha256(imagePath + effect + colorGrade + overlays + duration + fps + w + h + composition)
    -- Value = path to the rendered .mp4 clip
    CREATE TABLE IF NOT EXISTS render_cache (
      cache_key         TEXT PRIMARY KEY,
      clip_path         TEXT NOT NULL,
      thumb_path        TEXT,
      image_path        TEXT,
      effect            TEXT,
      composition       TEXT,
      color_grade       TEXT,
      overlays          TEXT,
      duration          REAL,
      width             INTEGER,
      height            INTEGER,
      fps               INTEGER,
      file_size_bytes   INTEGER,
      hit_count         INTEGER DEFAULT 0,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_used_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- ─── COMPOSITION MARKETPLACE ─────────────────────────────────────────────
    -- DB-driven: add/edit compositions without code deploys
    CREATE TABLE IF NOT EXISTS compositions (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,           -- display name
      slug              TEXT UNIQUE NOT NULL,    -- used in code (e.g. "my_custom")
      category          TEXT NOT NULL,           -- panels|reveals|focus|impact|cinematic|custom
      description       TEXT,
      ffmpeg_template   TEXT NOT NULL,           -- full filter_complex template with {{VARS}}
      thumbnail_url     TEXT,
      is_builtin        INTEGER DEFAULT 0,       -- 1=ships with app, 0=user-added
      is_active         INTEGER DEFAULT 1,
      author            TEXT DEFAULT 'system',
      vote_count        INTEGER DEFAULT 0,
      use_count         INTEGER DEFAULT 0,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      notes             TEXT
    );

    -- ─── COMPOSITION VOTES ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS composition_votes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      composition_id    TEXT NOT NULL REFERENCES compositions(id) ON DELETE CASCADE,
      voter_ip          TEXT,
      voted_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(composition_id, voter_ip)
    );

    -- ─── EFFECTS OVERRIDES (DB-driven toggles) ───────────────────────────────
    -- Admin can disable specific effects/transitions/grades without code changes
    CREATE TABLE IF NOT EXISTS effects_registry (
      id                TEXT PRIMARY KEY,   -- e.g. "effect:zoom_punch"
      type              TEXT NOT NULL,      -- effect|transition|grade|overlay
      name              TEXT NOT NULL,
      is_active         INTEGER DEFAULT 1,
      label             TEXT,
      category          TEXT,
      description       TEXT,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- ─── TRAINING SAMPLES ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS training_samples (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      source_video      TEXT,
      timestamp         REAL,
      bpm               REAL,
      energy            REAL,
      relative_energy   REAL,
      centroid          REAL,
      onset             REAL,
      beat_alignment    REAL,
      segment_duration  REAL,
      mean_brightness       REAL,
      brightness_variance   REAL,
      dominant_hue          REAL,
      saturation            REAL,
      color_temperature     REAL,
      edge_density          REAL,
      face_present          INTEGER,
      dark_scene            INTEGER,
      action_scene          INTEGER,
      contrast              REAL,
      warm_dominant         INTEGER,
      transition        TEXT,
      effect            TEXT,
      color_grade       TEXT,
      composition       TEXT,
      stutter_cut       INTEGER DEFAULT 0,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      source_type       TEXT DEFAULT 'amv'
    );

    -- ─── MODEL VERSIONS ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS model_versions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      trained_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      sample_count      INTEGER,
      accuracy_transition   REAL,
      accuracy_effect       REAL,
      accuracy_grade        REAL,
      model_path        TEXT,
      features_used     TEXT,
      notes             TEXT
    );

    -- ─── INDEXES ─────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_scenes_session      ON scenes(session_id);
    CREATE INDEX IF NOT EXISTS idx_scenes_edited       ON scenes(was_edited) WHERE was_edited = 1;
    CREATE INDEX IF NOT EXISTS idx_training_source     ON training_samples(source_type);
    CREATE INDEX IF NOT EXISTS idx_jobs_status         ON render_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_session        ON render_jobs(session_id);
    CREATE INDEX IF NOT EXISTS idx_cache_last_used     ON render_cache(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_compositions_active ON compositions(is_active, category);

    -- ─── LLM RESULT CACHE ─────────────────────────────────────────────────
    -- Caches full LLM advisory results by audio+images+settings fingerprint
    CREATE TABLE IF NOT EXISTS llm_cache (
      cache_key         TEXT PRIMARY KEY,
      audio_hash        TEXT NOT NULL,
      image_hash        TEXT NOT NULL,
      scene_count       INTEGER,
      result_json       TEXT NOT NULL,
      provider          TEXT,
      hit_count         INTEGER DEFAULT 0,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_used_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_llm_cache_audio ON llm_cache(audio_hash);
  `);

  // Run migrations for columns added after initial creation
  _migrate(db);
}

function _migrate(db) {
  // Add columns that may not exist in older DBs
  const safeAdd = (table, col, def) => {
    try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); } catch {}
  };
  safeAdd("sessions", "job_id", "TEXT");
  safeAdd("sessions", "status", "TEXT DEFAULT 'ready'");
  safeAdd("scenes", "composition", "TEXT");
  safeAdd("scenes", "llm_reasoning", "TEXT");
  safeAdd("scenes", "edit_source", "TEXT DEFAULT 'patterns'");
  safeAdd("scenes", "edit_count", "INTEGER DEFAULT 0");
  safeAdd("scenes", "render_cache_key", "TEXT");
  safeAdd("scenes", "clip_path", "TEXT");
  safeAdd("scenes", "thumb_path", "TEXT");
  safeAdd("training_samples", "composition", "TEXT");
}


// ═══════════════════════════════════════════════════════════════════════════
// RENDER JOB QUEUE
// ═══════════════════════════════════════════════════════════════════════════

function createJob({ jobId, sessionId, jobType, totalScenes = 0, params = {}, priority = 5 }) {
  const db = getDb();
  if (!db) return null;
  try {
    db.prepare(`
      INSERT INTO render_jobs (id, session_id, job_type, total_scenes, params_json, priority)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobId, sessionId || null, jobType, totalScenes, JSON.stringify(params), priority);
    return jobId;
  } catch (e) {
    console.error("   ❌ DB createJob:", e.message);
    return null;
  }
}

function updateJobProgress(jobId, { scenesDone, totalScenes, progressPct, label, workerId } = {}) {
  const db = getDb();
  if (!db) return;
  try {
    const parts = [];
    const vals  = [];
    if (scenesDone   !== undefined) { parts.push("scenes_done = ?");   vals.push(scenesDone); }
    if (totalScenes  !== undefined) { parts.push("total_scenes = ?");  vals.push(totalScenes); }
    if (progressPct  !== undefined) { parts.push("progress_pct = ?");  vals.push(progressPct); }
    if (label        !== undefined) { parts.push("progress_label = ?");vals.push(label); }
    if (workerId     !== undefined) { parts.push("worker_id = ?");     vals.push(workerId); }
    if (!parts.length) return;
    vals.push(jobId);
    db.prepare(`UPDATE render_jobs SET ${parts.join(",")} WHERE id = ?`).run(...vals);
  } catch (e) {
    console.error("   ❌ DB updateJobProgress:", e.message);
  }
}

function setJobStatus(jobId, status, { result, error } = {}) {
  const db = getDb();
  if (!db) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    if (status === "processing") {
      db.prepare(`UPDATE render_jobs SET status=?, started_at=? WHERE id=?`).run(status, now, jobId);
    } else if (status === "done" || status === "failed" || status === "cancelled") {
      db.prepare(`UPDATE render_jobs SET status=?, completed_at=?, result_json=?, error_message=?, progress_pct=? WHERE id=?`)
        .run(status, now, result ? JSON.stringify(result) : null, error || null, status === "done" ? 100 : null, jobId);
    } else {
      db.prepare(`UPDATE render_jobs SET status=? WHERE id=?`).run(status, jobId);
    }
  } catch (e) {
    console.error("   ❌ DB setJobStatus:", e.message);
  }
}

function getJob(jobId) {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT * FROM render_jobs WHERE id = ?`).get(jobId);
    if (!row) return null;
    return {
      ...row,
      params: row.params_json ? JSON.parse(row.params_json) : {},
      result: row.result_json ? JSON.parse(row.result_json) : null,
    };
  } catch (e) { return null; }
}

function getSessionJobs(sessionId) {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare(`SELECT * FROM render_jobs WHERE session_id = ? ORDER BY created_at DESC`).all(sessionId);
  } catch { return []; }
}

function getPendingJobs(limit = 10) {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`SELECT * FROM render_jobs WHERE status = 'pending' ORDER BY priority ASC, created_at ASC LIMIT ?`).all(limit);
    return rows.map(row => ({
      ...row,
      params: row.params_json ? JSON.parse(row.params_json) : {},
      result: row.result_json ? JSON.parse(row.result_json) : null,
    }));
  } catch { return []; }
}


// ═══════════════════════════════════════════════════════════════════════════
// RENDER CACHE
// ═══════════════════════════════════════════════════════════════════════════

function getCachedRender(cacheKey) {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT * FROM render_cache WHERE cache_key = ?`).get(cacheKey);
    if (!row) return null;
    // Update hit stats
    db.prepare(`UPDATE render_cache SET hit_count = hit_count + 1, last_used_at = strftime('%s','now') WHERE cache_key = ?`).run(cacheKey);
    return row;
  } catch { return null; }
}

function saveCachedRender({ cacheKey, clipPath, thumbPath, imagePath, effect, composition, colorGrade, overlays, duration, width, height, fps, fileSizeBytes }) {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(`
      INSERT OR REPLACE INTO render_cache
        (cache_key, clip_path, thumb_path, image_path, effect, composition, color_grade, overlays, duration, width, height, fps, file_size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(cacheKey, clipPath, thumbPath || null, imagePath || null, effect || null, composition || null, colorGrade || null,
           JSON.stringify(overlays || []), duration, width, height, fps, fileSizeBytes || 0);
  } catch (e) {
    console.error("   ❌ DB saveCachedRender:", e.message);
  }
}

function pruneCacheOlderThan(daysOld = 7) {
  const db = getDb();
  if (!db) return 0;
  try {
    const cutoff = Math.floor(Date.now() / 1000) - (daysOld * 86400);
    const result = db.prepare(`DELETE FROM render_cache WHERE last_used_at < ?`).run(cutoff);
    return result.changes;
  } catch { return 0; }
}

function getCacheStats() {
  const db = getDb();
  if (!db) return {};
  try {
    const row = db.prepare(`SELECT COUNT(*) as total, SUM(file_size_bytes) as total_bytes, SUM(hit_count) as total_hits FROM render_cache`).get();
    return { entries: row.total, totalMB: ((row.total_bytes || 0) / 1024 / 1024).toFixed(1), totalHits: row.total_hits || 0 };
  } catch { return {}; }
}


// ═══════════════════════════════════════════════════════════════════════════
// COMPOSITION MARKETPLACE
// ═══════════════════════════════════════════════════════════════════════════

function getCompositions({ category, activeOnly = true } = {}) {
  const db = getDb();
  if (!db) return [];
  try {
    let q = `SELECT * FROM compositions WHERE 1=1`;
    const params = [];
    if (activeOnly) { q += ` AND is_active = 1`; }
    if (category)   { q += ` AND category = ?`; params.push(category); }
    q += ` ORDER BY vote_count DESC, use_count DESC, created_at ASC`;
    return db.prepare(q).all(...params);
  } catch { return []; }
}

function getComposition(slug) {
  const db = getDb();
  if (!db) return null;
  try {
    return db.prepare(`SELECT * FROM compositions WHERE slug = ? AND is_active = 1`).get(slug);
  } catch { return null; }
}

function saveComposition({ id, name, slug, category, description, ffmpegTemplate, thumbnailUrl, isBuiltin = false, author = "user", notes }) {
  const db = getDb();
  if (!db) return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT OR REPLACE INTO compositions (id, name, slug, category, description, ffmpeg_template, thumbnail_url, is_builtin, author, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, slug, category, description || null, ffmpegTemplate, thumbnailUrl || null, isBuiltin ? 1 : 0, author, notes || null, now);
    return id;
  } catch (e) {
    console.error("   ❌ DB saveComposition:", e.message);
    return null;
  }
}

function toggleComposition(slug, isActive) {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(`UPDATE compositions SET is_active = ?, updated_at = strftime('%s','now') WHERE slug = ?`).run(isActive ? 1 : 0, slug);
  } catch (e) {
    console.error("   ❌ DB toggleComposition:", e.message);
  }
}

function voteComposition(compositionId, voterIp) {
  const db = getDb();
  if (!db) return { success: false, message: "DB unavailable" };
  try {
    db.prepare(`INSERT OR IGNORE INTO composition_votes (composition_id, voter_ip) VALUES (?, ?)`).run(compositionId, voterIp);
    const changed = db.prepare(`SELECT changes() as c`).get().c;
    if (changed > 0) {
      db.prepare(`UPDATE compositions SET vote_count = vote_count + 1 WHERE id = ?`).run(compositionId);
      return { success: true, voted: true };
    }
    return { success: true, voted: false, message: "Already voted" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function incrementCompositionUse(slug) {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(`UPDATE compositions SET use_count = use_count + 1 WHERE slug = ?`).run(slug);
  } catch {}
}

// Seed built-in compositions from compositionEngine on first run
function seedBuiltinCompositions(compositionNames, categories) {
  const db = getDb();
  if (!db) return;
  try {
    const existing = db.prepare(`SELECT COUNT(*) as c FROM compositions WHERE is_builtin = 1`).get().c;
    if (existing >= compositionNames.length) return; // already seeded

    const { v4: uuidv4 } = require("uuid");
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO compositions (id, name, slug, category, description, ffmpeg_template, is_builtin, author)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'system')
    `);

    const slugToCategory = {};
    for (const [catKey, catVal] of Object.entries(categories)) {
      for (const slug of catVal.compositions) {
        slugToCategory[slug] = catKey;
      }
    }

    const seedMany = db.transaction(() => {
      for (const slug of compositionNames) {
        const cat = slugToCategory[slug] || "cinematic";
        const name = slug.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        stmt.run(uuidv4(), name, slug, cat, `Built-in: ${name}`, `builtin:${slug}`, );
      }
    });
    seedMany();
    console.log(`   💾 Seeded ${compositionNames.length} built-in compositions`);
  } catch (e) {
    console.error("   ❌ seedBuiltinCompositions:", e.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════════════════════════════════════

function saveSession({ sessionId, audioFile, bpm, sceneCount, totalDuration, aspectRatio, emotionSummary, jobId }) {
  const db = getDb();
  if (!db) return null;
  try {
    db.prepare(`
      INSERT OR REPLACE INTO sessions (id, audio_file, bpm, scene_count, total_duration, aspect_ratio, emotion_summary, job_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, audioFile || null, bpm || 0, sceneCount || 0, totalDuration || 0, aspectRatio || "9:16", emotionSummary || null, jobId || null);
    return sessionId;
  } catch (e) {
    console.error("   ❌ DB saveSession:", e.message);
    return null;
  }
}

function updateSessionExport(sessionId, exportPath) {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(`UPDATE sessions SET export_path=?, exported_at=strftime('%s','now'), status='done' WHERE id=?`).run(exportPath, sessionId);
  } catch (e) {
    console.error("   ❌ DB updateSessionExport:", e.message);
  }
}

function rateSession(sessionId, rating) {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(`UPDATE sessions SET user_rating=? WHERE id=?`).run(rating, sessionId);
  } catch {}
}

function getRecentSessions(limit = 20) {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?`).all(limit);
  } catch { return []; }
}


// ═══════════════════════════════════════════════════════════════════════════
// SCENES
// ═══════════════════════════════════════════════════════════════════════════

function saveScenes(sessionId, scenes) {
  const db = getDb();
  if (!db) return;
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO scenes (
        session_id, scene_index, start_time, duration, emotion,
        composition, llm_reasoning, edit_source,
        suggested_effect, suggested_transition, suggested_color_grade, suggested_overlays,
        final_effect, final_transition, final_color_grade, final_overlays,
        beat_alignment, energy, onset, centroid, segment_bpm, drop_strength,
        mean_brightness, brightness_variance, dominant_hue, saturation,
        color_temperature, edge_density, face_present, dark_scene, action_scene,
        contrast, warm_dominant, is_stutter_cut, stutter_type, media_path
      ) VALUES (
        ?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?,
        ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?,
        ?,?,?,?
      )
    `);

    const insertMany = db.transaction((list) => {
      for (const s of list) {
        const vf = s.visualFeatures || {};
        const sf = s.segmentFeatures || {};
        stmt.run(
          sessionId, s.index ?? 0, s.start ?? 0, s.duration ?? 0, s.emotion || "neutral",
          s.composition || null, s.llmReasoning || null, s.editSource || "patterns",
          s.suggestedEffect || s.effect, s.suggestedTransition || s.transition,
          s.suggestedColorGrade || s.colorGrade || "none", JSON.stringify(s.overlays || []),
          s.effect, s.transition, s.colorGrade || "none", JSON.stringify(s.overlays || []),
          s.beatAlignment ?? null, sf.energy ?? null, sf.onset ?? null,
          sf.centroid ?? null, sf.bpm ?? null, s.dropStrength ?? null,
          vf.mean_brightness ?? null, vf.brightness_variance ?? null,
          vf.dominant_hue ?? null, vf.saturation ?? null,
          vf.color_temperature ?? null, vf.edge_density ?? null,
          vf.face_present ?? null, vf.dark_scene ?? null, vf.action_scene ?? null,
          vf.contrast ?? null, vf.warm_dominant ?? null,
          s.isStutterCut ? 1 : 0, s.stutterType || null, s.mediaPath || null
        );
      }
    });
    insertMany(scenes);
    console.log(`   💾 Saved ${scenes.length} scenes to database`);
  } catch (e) {
    console.error("   ❌ DB saveScenes:", e.message);
  }
}

function recordSceneEdit(sessionId, sceneIndex, { effect, transition, colorGrade, overlays, composition }) {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(`
      UPDATE scenes SET
        was_edited=1, edited_at=strftime('%s','now'),
        edit_count=edit_count+1,
        final_effect=?, final_transition=?, final_color_grade=?, final_overlays=?,
        composition=?
      WHERE session_id=? AND scene_index=?
    `).run(effect, transition, colorGrade || "none", JSON.stringify(overlays || []),
           composition || null, sessionId, sceneIndex);
  } catch (e) {
    console.error("   ❌ DB recordSceneEdit:", e.message);
  }
}

function getEditedScenes(limit = 5000) {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT s.*, se.bpm as session_bpm FROM scenes s
      JOIN sessions se ON se.id = s.session_id
      WHERE s.was_edited = 1 ORDER BY s.edited_at DESC LIMIT ?
    `).all(limit);
  } catch { return []; }
}


// ═══════════════════════════════════════════════════════════════════════════
// TRAINING SAMPLES + MODEL VERSIONS
// ═══════════════════════════════════════════════════════════════════════════

function saveTrainingSamples(samples) {
  const db = getDb();
  if (!db) return 0;
  try {
    const stmt = db.prepare(`
      INSERT INTO training_samples (
        source_video, timestamp, bpm, energy, relative_energy, centroid, onset, beat_alignment, segment_duration,
        mean_brightness, brightness_variance, dominant_hue, saturation, color_temperature, edge_density,
        face_present, dark_scene, action_scene, contrast, warm_dominant,
        transition, effect, color_grade, composition, stutter_cut, source_type
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertMany = db.transaction((list) => {
      for (const s of list) {
        stmt.run(s.source_video, s.timestamp, s.bpm, s.energy, s.relative_energy, s.centroid, s.onset, s.beat_alignment, s.segment_duration,
          s.mean_brightness, s.brightness_variance, s.dominant_hue, s.saturation, s.color_temperature, s.edge_density,
          s.face_present, s.dark_scene, s.action_scene, s.contrast, s.warm_dominant,
          s.transition, s.effect, s.color_grade, s.composition || null, s.stutter_cut ? 1 : 0, s.source_type || "amv");
      }
    });
    insertMany(samples);
    return samples.length;
  } catch (e) {
    console.error("   ❌ DB saveTrainingSamples:", e.message);
    return 0;
  }
}

function saveModelVersion({ sampleCount, accuracyTransition, accuracyEffect, accuracyGrade, modelPath, featuresUsed, notes }) {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(`INSERT INTO model_versions (sample_count, accuracy_transition, accuracy_effect, accuracy_grade, model_path, features_used, notes) VALUES (?,?,?,?,?,?,?)`)
      .run(sampleCount, accuracyTransition, accuracyEffect, accuracyGrade, modelPath, featuresUsed, notes);
  } catch (e) { console.error("   ❌ DB saveModelVersion:", e.message); }
}


// ═══════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════

function getDbStats() {
  const db = getDb();
  if (!db) return { enabled: false };
  try {
    const q = (sql) => db.prepare(sql).get();
    return {
      enabled:         true,
      path:            DB_PATH,
      sessions:        q("SELECT COUNT(*) as c FROM sessions").c,
      scenes:          q("SELECT COUNT(*) as c FROM scenes").c,
      editedScenes:    q("SELECT COUNT(*) as c FROM scenes WHERE was_edited=1").c,
      trainingSamples: q("SELECT COUNT(*) as c FROM training_samples").c,
      modelVersions:   q("SELECT COUNT(*) as c FROM model_versions").c,
      renderJobs:      q("SELECT COUNT(*) as c FROM render_jobs").c,
      pendingJobs:     q("SELECT COUNT(*) as c FROM render_jobs WHERE status='pending'").c,
      cacheEntries:    q("SELECT COUNT(*) as c FROM render_cache").c,
      compositions:    q("SELECT COUNT(*) as c FROM compositions WHERE is_active=1").c,
    };
  } catch (e) { return { enabled: true, error: e.message }; }
}


// ─── LLM RESULT CACHE ────────────────────────────────────────────────────────

function getLlmCache(cacheKey) {
  const db = getDb(); if (!db) return null;
  try {
    const row = db.prepare("SELECT * FROM llm_cache WHERE cache_key = ?").get(cacheKey);
    if (!row) return null;
    db.prepare("UPDATE llm_cache SET hit_count = hit_count + 1, last_used_at = strftime('%s','now') WHERE cache_key = ?").run(cacheKey);
    return { ...row, result: JSON.parse(row.result_json) };
  } catch { return null; }
}

function saveLlmCache({ cacheKey, audioHash, imageHash, sceneCount, result, provider }) {
  const db = getDb(); if (!db) return false;
  try {
    db.prepare(`INSERT OR REPLACE INTO llm_cache (cache_key, audio_hash, image_hash, scene_count, result_json, provider)
      VALUES (?, ?, ?, ?, ?, ?)`).run(cacheKey, audioHash, imageHash, sceneCount, JSON.stringify(result), provider || "unknown");
    return true;
  } catch { return false; }
}

function pruneLlmCache(daysOld = 30) {
  const db = getDb(); if (!db) return 0;
  try {
    const cutoff = Math.floor(Date.now() / 1000) - daysOld * 86400;
    const r = db.prepare("DELETE FROM llm_cache WHERE last_used_at < ?").run(cutoff);
    return r.changes;
  } catch { return 0; }
}


// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  getDb,
  // Sessions
  saveSession, updateSessionExport, rateSession, getRecentSessions,
  // Scenes
  saveScenes, recordSceneEdit, getEditedScenes,
  // Job Queue
  createJob, updateJobProgress, setJobStatus, getJob, getSessionJobs, getPendingJobs,
  // Render Cache
  getCachedRender, saveCachedRender, pruneCacheOlderThan, getCacheStats,
  // LLM Cache
  getLlmCache, saveLlmCache, pruneLlmCache,
  // Composition Marketplace
  getCompositions, getComposition, saveComposition, toggleComposition,
  voteComposition, incrementCompositionUse, seedBuiltinCompositions,
  // Training
  saveTrainingSamples, saveModelVersion,
  // Stats
  getDbStats,
};
