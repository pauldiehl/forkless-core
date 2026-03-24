const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler } = require('../core/scheduler');

describe('scheduler', () => {
  let scheduler;

  beforeEach(() => {
    scheduler = createScheduler({ tickIntervalMs: 100 });
  });

  it('schedules a one-time job', async () => {
    const job = await scheduler.schedule({
      type: 'test_job',
      runAt: new Date().toISOString(),
      params: { x: 1 }
    });
    assert.ok(job.id.startsWith('job_'));
    assert.equal(job.type, 'test_job');
    assert.equal(job.recurring, false);
    assert.equal(job.enabled, true);
    assert.equal(job.run_count, 0);
  });

  it('schedules a recurring job', async () => {
    const job = await scheduler.schedule({
      type: 'check_status',
      intervalMs: 60000,
      params: {}
    });
    assert.equal(job.recurring, true);
    assert.equal(job.interval_ms, 60000);
  });

  it('requires type', async () => {
    await assert.rejects(() => scheduler.schedule({ runAt: new Date().toISOString() }), /type is required/);
  });

  it('requires runAt or intervalMs', async () => {
    await assert.rejects(() => scheduler.schedule({ type: 'x' }), /Either runAt or intervalMs/);
  });

  it('executes due one-time job on tick', async () => {
    let called = false;
    scheduler.registerHandler('test', async (params) => {
      called = true;
      return { ok: true };
    });

    await scheduler.schedule({ type: 'test', runAt: new Date(Date.now() - 1000).toISOString() });
    await scheduler.tick();
    assert.ok(called);

    // One-time job removed after execution
    const jobs = await scheduler.list();
    assert.equal(jobs.length, 0);
  });

  it('executes recurring job and reschedules', async () => {
    let callCount = 0;
    scheduler.registerHandler('recurring', async () => { callCount++; });

    await scheduler.schedule({ type: 'recurring', intervalMs: 1000 });
    // Set next_run to past so it fires
    const jobs = await scheduler.list();
    jobs[0].next_run = new Date(Date.now() - 1000).toISOString();

    await scheduler.tick();
    assert.equal(callCount, 1);

    // Job still exists (recurring)
    const afterJobs = await scheduler.list();
    assert.equal(afterJobs.length, 1);
    assert.equal(afterJobs[0].run_count, 1);
  });

  it('does not execute future jobs', async () => {
    let called = false;
    scheduler.registerHandler('future', async () => { called = true; });
    await scheduler.schedule({ type: 'future', runAt: new Date(Date.now() + 100000).toISOString() });
    await scheduler.tick();
    assert.ok(!called);
  });

  it('does not execute paused jobs', async () => {
    let called = false;
    scheduler.registerHandler('paused', async () => { called = true; });
    const job = await scheduler.schedule({ type: 'paused', runAt: new Date(Date.now() - 1000).toISOString() });
    await scheduler.pause(job.id);
    await scheduler.tick();
    assert.ok(!called);

    // Resume and tick
    await scheduler.resume(job.id);
    await scheduler.tick();
    assert.ok(called);
  });

  it('cancels a job', async () => {
    await scheduler.schedule({ type: 'x', runAt: new Date().toISOString() });
    const jobs = await scheduler.list();
    assert.equal(jobs.length, 1);
    await scheduler.cancel(jobs[0].id);
    assert.equal((await scheduler.list()).length, 0);
  });

  it('handles job errors gracefully', async () => {
    let errorCaught = null;
    const s = createScheduler({
      onJobError: (job, err) => { errorCaught = err; }
    });
    s.registerHandler('fail', async () => { throw new Error('boom'); });
    await s.schedule({ type: 'fail', runAt: new Date(Date.now() - 1000).toISOString() });
    await s.tick();
    assert.ok(errorCaught);
    assert.equal(errorCaught.message, 'boom');

    // Job still exists with error recorded
    const jobs = await s.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].last_result.error, 'boom');
  });

  it('reports missing handler', async () => {
    let errorCaught = null;
    const s = createScheduler({
      onJobError: (job, err) => { errorCaught = err; }
    });
    await s.schedule({ type: 'no_handler', runAt: new Date(Date.now() - 1000).toISOString() });
    await s.tick();
    assert.ok(errorCaught);
    assert.ok(errorCaught.message.includes('no_handler'));
  });
});
