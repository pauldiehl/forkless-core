const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('../db/adapter');
const { createContextManager } = require('../core/context');

let db, ctx;

beforeEach(() => {
  db = createAdapter(':memory:');
  ctx = createContextManager({ db });
});

describe('context.create', () => {
  it('creates a context object with correct structure', () => {
    const context = ctx.create({
      journey_type: 'medical_consult_labs',
      user_id: 'user_1',
      conversation_id: 'convo_1',
      initialBlock: 'presentation'
    });
    assert.equal(context.journey_type, 'medical_consult_labs');
    assert.equal(context.current_block, 'presentation');
    assert.equal(context.block_state, null);
    assert.equal(context.journey_status, 'not_started');
    assert.equal(context.block_history.length, 1);
    assert.equal(context.block_history[0].block, 'presentation');
  });

  it('creates without initial block', () => {
    const context = ctx.create({ journey_type: 'labs', user_id: 'u1' });
    assert.equal(context.current_block, null);
    assert.equal(context.block_history.length, 0);
  });
});

describe('context.read', () => {
  it('reads context from a journey instance', () => {
    const user = db.users.create({ email: 'jane@example.com' });
    const initialCtx = ctx.create({ journey_type: 'labs', user_id: user.id, initialBlock: 'intake' });
    const ji = db.journeyInstances.create({ user_id: user.id, journey_type: 'labs', context: initialCtx });
    const readCtx = ctx.read(ji.id);
    assert.equal(readCtx.current_block, 'intake');
    assert.equal(readCtx.journey_type, 'labs');
  });

  it('returns null for nonexistent journey', () => {
    assert.equal(ctx.read('nonexistent'), null);
  });
});

describe('context.update', () => {
  let ji;

  beforeEach(() => {
    const user = db.users.create({ email: 'jane@example.com' });
    const initialCtx = ctx.create({ journey_type: 'labs', user_id: user.id, initialBlock: 'intake' });
    ji = db.journeyInstances.create({ user_id: user.id, journey_type: 'labs', context: initialCtx });
  });

  it('updates flat keys', () => {
    const updated = ctx.update(ji.id, { current_block: 'payment', journey_status: 'in_progress' });
    assert.equal(updated.current_block, 'payment');
    assert.equal(updated.journey_status, 'in_progress');
    // Persisted
    const readBack = ctx.read(ji.id);
    assert.equal(readBack.current_block, 'payment');
  });

  it('updates namespaced keys with dot notation', () => {
    const updated = ctx.update(ji.id, {
      'intake.customerName': 'Jane',
      'intake.customerEmail': 'jane@x.com'
    });
    assert.equal(updated.intake.customerName, 'Jane');
    assert.equal(updated.intake.customerEmail, 'jane@x.com');
  });

  it('throws for nonexistent journey', () => {
    assert.throws(() => ctx.update('bad_id', { x: 1 }), /not found/);
  });
});

describe('context.snapshot / restore', () => {
  let ji;

  beforeEach(() => {
    const user = db.users.create({ email: 'jane@example.com' });
    const initialCtx = ctx.create({ journey_type: 'labs', user_id: user.id, initialBlock: 'intake' });
    ji = db.journeyInstances.create({ user_id: user.id, journey_type: 'labs', context: initialCtx });
  });

  it('takes a snapshot and restores it', () => {
    ctx.update(ji.id, { current_block: 'payment', 'intake.name': 'Jane' });
    const snap = ctx.snapshot(ji.id);
    assert.equal(snap.context.current_block, 'payment');
    assert.ok(snap.snapshot_at);

    // Modify further
    ctx.update(ji.id, { current_block: 'followup' });
    assert.equal(ctx.read(ji.id).current_block, 'followup');

    // Restore
    ctx.restore(ji.id, snap);
    assert.equal(ctx.read(ji.id).current_block, 'payment');
  });

  it('snapshot is a deep clone (modifying it does not affect DB)', () => {
    const snap = ctx.snapshot(ji.id);
    snap.context.current_block = 'MODIFIED';
    assert.equal(ctx.read(ji.id).current_block, 'intake');
  });
});

describe('context.applyUpdate', () => {
  it('merges namespaced objects', () => {
    const base = { intake: { name: 'Jane' }, current_block: 'intake' };
    const result = ctx.applyUpdate(base, { intake: { email: 'j@x.com' } });
    assert.equal(result.intake.name, 'Jane');
    assert.equal(result.intake.email, 'j@x.com');
  });

  it('overwrites scalar values', () => {
    const base = { current_block: 'intake' };
    const result = ctx.applyUpdate(base, { current_block: 'payment' });
    assert.equal(result.current_block, 'payment');
  });

  it('does not mutate original', () => {
    const base = { current_block: 'intake' };
    ctx.applyUpdate(base, { current_block: 'payment' });
    assert.equal(base.current_block, 'intake');
  });
});
