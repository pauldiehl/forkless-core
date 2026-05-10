/**
 * Embedded scheduler for Forkless Core.
 *
 * Lightweight, in-process scheduler for recurring and one-time tasks.
 * No external dependencies (no cron daemon, no Redis, no SQS).
 * Uses setInterval for ticking and a simple queue for pending jobs.
 *
 * Adapted from forkless/lib/core/scheduler.js.
 * Added: DB-backed storage option, consistent ID generation.
 */

const crypto = require('crypto');

function createScheduler(opts = {}) {
  const tickIntervalMs = opts.tickIntervalMs || 60 * 1000;
  const onJobRun = opts.onJobRun || (() => {});
  const onJobError = opts.onJobError || (() => {});

  // Default to in-memory storage; can be replaced with DB-backed storage
  const memoryStore = {};
  const storage = opts.storage || {
    async put(id, data) { memoryStore[id] = data; },
    async get(id) { return memoryStore[id] || null; },
    async list() { return Object.values(memoryStore); },
    async remove(id) { delete memoryStore[id]; }
  };

  let tickTimer = null;
  const handlers = {};

  function generateJobId() {
    return `job_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  function registerHandler(jobType, handler) {
    handlers[jobType] = handler;
  }

  async function schedule(job) {
    if (!job.type) throw new Error('Job type is required');
    if (!job.runAt && !job.intervalMs) throw new Error('Either runAt or intervalMs is required');

    const entry = {
      id: job.id || generateJobId(),
      type: job.type,
      params: job.params || {},
      description: job.description || '',
      recurring: !!job.intervalMs,
      interval_ms: job.intervalMs || null,
      next_run: job.runAt || new Date(Date.now() + job.intervalMs).toISOString(),
      enabled: true,
      run_count: 0,
      last_run: null,
      last_result: null,
      created_at: new Date().toISOString()
    };

    await storage.put(entry.id, entry);
    return entry;
  }

  async function cancel(jobId) {
    await storage.remove(jobId);
  }

  async function pause(jobId) {
    const job = await storage.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    job.enabled = false;
    await storage.put(jobId, job);
    return job;
  }

  async function resume(jobId) {
    const job = await storage.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    job.enabled = true;
    await storage.put(jobId, job);
    return job;
  }

  async function tick() {
    const now = new Date();
    const jobs = await storage.list();

    for (const job of jobs) {
      if (!job.enabled) continue;
      if (new Date(job.next_run) > now) continue;

      const handler = handlers[job.type];
      if (!handler) {
        onJobError(job, new Error(`No handler registered for job type: ${job.type}`));
        continue;
      }

      try {
        const result = await handler(job.params);
        job.run_count++;
        job.last_run = now.toISOString();
        job.last_result = result;
        onJobRun(job, result);

        if (job.recurring && job.interval_ms) {
          job.next_run = new Date(now.getTime() + job.interval_ms).toISOString();
          await storage.put(job.id, job);
        } else {
          await storage.remove(job.id);
        }
      } catch (err) {
        job.last_run = now.toISOString();
        job.last_result = { error: err.message };
        await storage.put(job.id, job);
        onJobError(job, err);
      }
    }
  }

  function start() {
    if (tickTimer) return;
    tickTimer = setInterval(tick, tickIntervalMs);
    tick();
  }

  function stop() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  async function list() {
    return storage.list();
  }

  /**
   * Look up a registered handler by job type. Useful for admin tooling
   * that wants to invoke a job's handler immediately without going
   * through the schedule → tick → run path (e.g. "force this job now").
   */
  function getHandler(jobType) {
    return handlers[jobType] || null;
  }

  return {
    registerHandler,
    getHandler,
    schedule,
    cancel,
    pause,
    resume,
    tick,
    start,
    stop,
    list
  };
}

module.exports = { createScheduler };
