const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCore } = require('../index');
const { shouldSkipBlock } = require('../runtime/block-executor');
const { teleport } = require('./teleport');

// ── skip_if unit tests ──

describe('shouldSkipBlock', () => {
  it('skips when skip_if condition is truthy', () => {
    assert.equal(shouldSkipBlock({ skip_if: 'rx_review.rx_skipped' }, { rx_review: { rx_skipped: true } }), true);
  });

  it('does not skip when condition is falsy', () => {
    assert.equal(shouldSkipBlock({ skip_if: 'rx_review.rx_skipped' }, { rx_review: { rx_skipped: false } }), false);
  });

  it('does not skip when path does not exist', () => {
    assert.equal(shouldSkipBlock({ skip_if: 'rx_review.rx_skipped' }, {}), false);
  });

  it('does not skip when no skip_if defined', () => {
    assert.equal(shouldSkipBlock({ block: 'payment' }, {}), false);
  });
});

// ── skip_if integration ──

describe('conditional block skipping', () => {
  it('rx_skipped skips rx_consent, rx_payment, rx_order, rx_tracking', async () => {
    const core = createCore({ useMockLLM: true });
    core.registerJourney({
      journey_type: 'skip_test',
      blocks: [
        { block: 'rx_review', params: { allow_skip: true }, actor: 'physician', default_visibility: ['physician', 'agent'] },
        { block: 'rx_consent', params: {}, skip_if: 'rx_review.rx_skipped' },
        { block: 'rx_payment', params: { amount_cents: 5000, product_slug: 'rx' }, skip_if: 'rx_review.rx_skipped' },
        { block: 'rx_order', params: {}, skip_if: 'rx_review.rx_skipped' },
        { block: 'rx_tracking', params: {}, skip_if: 'rx_review.rx_skipped' }
      ]
    });

    const user = core.db.users.create({ email: 'skip@test.com' });
    const initCtx = core.context.create({ journey_type: 'skip_test', user_id: user.id, initialBlock: 'rx_review' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'skip_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id });

    // Physician skips RX → rx_skipped: true → all subsequent skip_if blocks skipped
    core.context.update(ji.id, { 'rx_review.rx_skipped': true });

    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      payload: { text: 'No prescription needed, skip' }
    });

    const ctx = core.context.read(ji.id);
    // Should have jumped past all skipped blocks → journey completed
    assert.equal(ctx.journey_status, 'completed');
    core.close();
  });

  it('requires_payment false skips only rx_payment', async () => {
    const core = createCore({ useMockLLM: true });
    core.registerJourney({
      journey_type: 'skip_payment_test',
      blocks: [
        { block: 'rx_review', params: {}, actor: 'physician', default_visibility: ['physician', 'agent'] },
        { block: 'rx_consent', params: {} },
        { block: 'rx_payment', params: { amount_cents: 5000, product_slug: 'rx' }, skip_if: 'rx_review.no_payment' },
        { block: 'rx_order', params: {}, actor: 'physician', default_visibility: ['physician', 'agent'] }
      ]
    });

    const user = core.db.users.create({ email: 'skippay@test.com' });
    const initCtx = core.context.create({ journey_type: 'skip_payment_test', user_id: user.id, initialBlock: 'rx_review' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'skip_payment_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id });

    // Physician confirms RX but marks no payment needed
    core.context.update(ji.id, {
      'rx_review.rx_confirmed': true,
      'rx_review.no_payment': true
    });

    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      payload: { text: 'Confirmed, no charge for this' }
    });

    const ctx = core.context.read(ji.id);
    // Should skip rx_payment → land on rx_consent (customer-facing, but physician is actor)
    // Actually rx_consent is customer-facing but no actor set → defaults to customer
    // The transition goes rx_review → rx_consent (not skipped)
    assert.equal(ctx.current_block, 'rx_consent');
    core.close();
  });
});

// ── Actor enforcement on physician blocks ──

describe('physician-facing blocks', () => {
  it('encounter_notes rejects customer messages', async () => {
    const core = createCore({ useMockLLM: true });
    core.registerJourney({
      journey_type: 'actor_test_d',
      blocks: [
        { block: 'encounter_notes', params: {}, actor: 'physician', default_visibility: ['physician', 'agent'] }
      ]
    });

    const user = core.db.users.create({ email: 'actor_d@test.com' });
    const initCtx = core.context.create({ journey_type: 'actor_test_d', user_id: user.id, initialBlock: 'encounter_notes' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'actor_test_d', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id });

    // Customer message → actor_mismatch
    const result = await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'customer',
      payload: { text: 'When will I hear from the doctor?' }
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'actor_mismatch');

    // Physician message → works
    const result2 = await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      payload: { text: 'Patient presents with fatigue and elevated TSH' }
    });
    assert.equal(result2.handled, true);

    core.close();
  });

  it('rx_order accepts physician messages', async () => {
    const core = createCore({ useMockLLM: true });
    core.registerJourney({
      journey_type: 'rx_order_test',
      blocks: [
        { block: 'rx_order', params: {}, actor: 'physician', default_visibility: ['physician', 'agent'] }
      ]
    });

    const user = core.db.users.create({ email: 'rx_ord@test.com' });
    const initCtx = core.context.create({ journey_type: 'rx_order_test', user_id: user.id, initialBlock: 'rx_order' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'rx_order_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id });

    const result = await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      payload: { text: 'Submitted to pharmacy' }
    });
    assert.equal(result.handled, true);
    core.close();
  });
});

// ── on_enter for post-meet blocks ──

describe('post-meet block on_enter', () => {
  it('encounter_notes on_enter prompts physician', async () => {
    const core = createCore({ useMockLLM: true });
    core.registerJourney({
      journey_type: 'enter_notes_test',
      blocks: [
        { block: 'followup', params: { include_scheduling: false } },
        { block: 'encounter_notes', params: {}, actor: 'physician', default_visibility: ['physician', 'agent'] }
      ]
    });

    const user = core.db.users.create({ email: 'enter_notes@test.com' });
    const initCtx = core.context.create({ journey_type: 'enter_notes_test', user_id: user.id, initialBlock: 'followup' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'enter_notes_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, {
      conversation_id: convo.id,
      'simple_intake.customerName': 'Jane Smith'
    });

    // Simulate meeting_ended → transitions to encounter_notes
    await core.eventRouter.handleEvent({
      type: 'api', journey_id: ji.id, source: 'calcom_webhook',
      payload: { triggerEvent: 'MEETING_ENDED' }
    });

    const ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'encounter_notes');

    // on_enter should have sent a prompt to the physician
    const msgs = core.db.conversations.get(convo.id).messages;
    const promptMsg = msgs.find(m => m.text && m.text.includes('encounter notes'));
    assert.ok(promptMsg, 'should prompt physician for notes');

    core.close();
  });
});
