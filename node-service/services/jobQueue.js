/**
 * Job Queue v1.0 — In-Process Async Render Queue with WebSocket Progress
 *
 * Architecture:
 *   - SQLite render_jobs table is the persistent queue
 *   - In-memory EventEmitter broadcasts progress to SSE/WebSocket clients
 *   - Single worker processes jobs serially (no CPU contention)
 *   - Multiple job types: prepare, rerender, export
 *
 * Why not BullMQ/Redis?
 *   BullMQ requires Redis running separately, which complicates single-machine
 *   setup. This implementation gives 90% of the benefits using only SQLite
 *   + Node.js EventEmitter, with zero extra dependencies.
 *   To scale to multiple servers: swap the EventEmitter for Redis pub/sub.
 *
 * Flow:
 *   1. POST /api/amv/prepare  → enqueue({ type: 'prepare', ... }) → returns jobId immediately
 *   2. Client subscribes: GET /api/amv/jobs/:jobId/progress (SSE)
 *   3. Worker picks up job, calls prepareSession(), emits progress events per scene
 *   4. On completion, job.status = 'done', result stored in DB
 *   5. Client polls GET /api/amv/jobs/:jobId → gets full result with sessionId
 */

const EventEmitter = require("events");
const { v4: uuidv4 } = require("uuid");
const db = require("./database");

// ─── GLOBAL EVENT BUS ────────────────────────────────────────────────────────
// All SSE subscribers listen on this. In multi-server, replace with Redis.
const eventBus = new EventEmitter();
eventBus.setMaxListeners(500); // support many concurrent users

// ─── WORKER STATE ─────────────────────────────────────────────────────────────
let _isWorkerRunning = false;
let _workerInterval  = null;
const WORKER_ID      = `worker_${process.pid}`;
const POLL_INTERVAL  = 1000; // check queue every 1s

// ─── PROGRESS EMISSION ────────────────────────────────────────────────────────

/**
 * Emit a progress event for a job. Stored in DB + broadcast to SSE subscribers.
 */
function emitProgress(jobId, { scenesDone, totalScenes, pct, label, sceneResult } = {}) {
  const progressPct = pct ?? (totalScenes > 0 ? Math.round((scenesDone / totalScenes) * 100) : 0);

  db.updateJobProgress(jobId, {
    scenesDone,
    totalScenes,
    progressPct,
    label: label || `Scene ${scenesDone}/${totalScenes}`,
  });

  // Broadcast to all SSE listeners for this job
  eventBus.emit(`job:${jobId}`, {
    jobId,
    scenesDone,
    totalScenes,
    pct: progressPct,
    label: label || `Scene ${scenesDone}/${totalScenes}`,
    sceneResult: sceneResult || null,
    timestamp: Date.now(),
  });
}

/**
 * Subscribe to progress events for a job. Returns an unsubscribe function.
 */
function subscribeToJob(jobId, callback) {
  const handler = (event) => callback(event);
  eventBus.on(`job:${jobId}`, handler);
  return () => eventBus.off(`job:${jobId}`, handler);
}

// ─── JOB CREATION ─────────────────────────────────────────────────────────────

/**
 * Enqueue a new render job. Returns jobId immediately (non-blocking).
 * The job will be processed by the background worker.
 */
function enqueueJob({ type, sessionId, params, priority = 5 }) {
  const jobId = uuidv4().slice(0, 12);
  db.createJob({
    jobId,
    sessionId: sessionId || null,
    jobType:   type,
    totalScenes: params?.scenes?.length || 0,
    params,
    priority,
  });
  console.log(`   📋 Job enqueued: ${jobId} (type=${type})`);
  _ensureWorkerRunning();
  return jobId;
}

// ─── WORKER ───────────────────────────────────────────────────────────────────

function _ensureWorkerRunning() {
  if (_workerInterval) return;
  _workerInterval = setInterval(_workerTick, POLL_INTERVAL);
  console.log(`   ⚙️  Job worker started (pid=${process.pid})`);
}

let _processingJob = false;

async function _workerTick() {
  if (_processingJob) return;

  const pending = db.getPendingJobs(1);
  if (!pending.length) return;

  const job = pending[0];
  _processingJob = true;
  db.setJobStatus(job.id, "processing");
  console.log(`   ⚙️  Worker processing job ${job.id} (${job.job_type})`);

  try {
    let result;

    if (job.job_type === "prepare") {
      result = await _runPrepareJob(job);
    } else if (job.job_type === "rerender") {
      result = await _runRerenderJob(job);
    } else if (job.job_type === "export") {
      result = await _runExportJob(job);
    } else {
      throw new Error(`Unknown job type: ${job.job_type}`);
    }

    db.setJobStatus(job.id, "done", { result });
    console.log(`   ✅ Job ${job.id} done`);
    eventBus.emit(`job:${job.id}`, { jobId: job.id, pct: 100, label: "Done", done: true, result });

  } catch (err) {
    console.error(`   ❌ Job ${job.id} failed:`, err.message);
    db.setJobStatus(job.id, "failed", { error: err.message });
    eventBus.emit(`job:${job.id}`, { jobId: job.id, pct: 0, label: "Failed", done: true, error: err.message });
  } finally {
    _processingJob = false;
  }
}

async function _runPrepareJob(job) {
  const { prepareSession } = require("./sceneRenderer");
  const params = job.params || {};

  const wrappedScenes = params.scenes || [];
  const totalScenes   = wrappedScenes.length;

  emitProgress(job.id, { scenesDone: 0, totalScenes, pct: 2, label: "Starting render..." });

  // Wrap prepareSession to emit progress per scene
  const meta = await prepareSession({
    ...params,
    onSceneDone: (sceneIdx, sceneResult) => {
      emitProgress(job.id, {
        scenesDone: sceneIdx + 1,
        totalScenes,
        label: `Scene ${sceneIdx + 1}/${totalScenes}`,
        sceneResult,
      });
    },
  });

  return { sessionId: meta.sessionId, sceneCount: meta.scenes.length };
}

async function _runRerenderJob(job) {
  const { rerenderScene } = require("./sceneRenderer");
  const { sessionId, sceneIndex, updates } = job.params || {};

  emitProgress(job.id, { scenesDone: 0, totalScenes: 1, pct: 10, label: "Re-rendering..." });
  const result = await rerenderScene(sessionId, sceneIndex, updates);
  emitProgress(job.id, { scenesDone: 1, totalScenes: 1, pct: 95, label: "Done", sceneResult: result });
  return result;
}

async function _runExportJob(job) {
  const { exportSession } = require("./sceneRenderer");
  const { sessionId, totalDuration } = job.params || {};

  emitProgress(job.id, { pct: 5, label: "Assembling video..." });
  const result = await exportSession(sessionId, totalDuration);
  emitProgress(job.id, { pct: 95, label: "Finalizing..." });
  return result;
}

// ─── SSE MIDDLEWARE ───────────────────────────────────────────────────────────

/**
 * Express SSE route handler for real-time job progress.
 * Usage: router.get('/jobs/:jobId/progress', sseProgressHandler)
 */
function sseProgressHandler(req, res) {
  const { jobId } = req.params;

  // Check job exists
  const job = db.getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering
  });

  // Send current state immediately
  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send current job state right away
  sendEvent({
    jobId,
    pct:    job.progress_pct || 0,
    label:  job.progress_label || "Queued",
    status: job.status,
    scenesDone: job.scenes_done || 0,
    totalScenes: job.total_scenes || 0,
  });

  // If already done, close immediately
  if (job.status === "done" || job.status === "failed") {
    sendEvent({ done: true, status: job.status, result: job.result });
    return res.end();
  }

  // Subscribe to live events
  const unsubscribe = subscribeToJob(jobId, (event) => {
    sendEvent(event);
    if (event.done) {
      res.end();
    }
  });

  // Heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  enqueueJob,
  subscribeToJob,
  emitProgress,
  sseProgressHandler,
  _ensureWorkerRunning,
};
