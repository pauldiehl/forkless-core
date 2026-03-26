/**
 * End-to-end journey test.
 *
 * Walks through a simplified medical consult journey:
 *   presentation → simple_intake → recommendation → payment
 *
 * Uses mock LLM, real DB, real context, real block executor, real event router.
 * Validates the full event lifecycle from user message to persisted state change.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCore } = require('../index');

describe('e2e: medical consult journey', () => {
  let core, user, ji, convo;

  const journeyDef = {
    journey_type: 'medical_consult',
    display_name: 'Medical Consultation',
    blocks: [
      { block: 'presentation', params: { offering_slug: 'hormone-panel' } },
      { block: 'simple_intake', params: { required_fields: ['customerName', 'customerEmail'] } },
      { block: 'recommendation', params: { price_cents: 14900 } },
      { block: 'payment', params: { amount_cents: 14900, product_slug: 'hormone-panel', provider: 'square' } }
    ]
  };

  beforeEach(() => {
    core = createCore({ dbPath: ':memory:', useMockLLM: true });

    // Register journey
    core.registerJourney(journeyDef);

    // Create user + journey + conversation
    user = core.db.users.create({ email: 'jane@example.com', name: 'Jane Smith' });
    const initCtx = core.context.create({
      journey_type: 'medical_consult',
      user_id: user.id,
      initialBlock: 'presentation'
    });
    initCtx.journey_status = 'in_progress';

    ji = core.db.journeyInstances.create({
      user_id: user.id,
      journey_type: 'medical_consult',
      context: initCtx,
      status: 'in_progress'
    });

    convo = core.db.conversations.create({
      user_id: user.id,
      journey_instance_id: ji.id
    });

    // Add conversation_id to context
    core.context.update(ji.id, { conversation_id: convo.id });
  });

  afterEach(() => {
    core.close();
  });

  it('walks through presentation → intake → recommendation → payment', async () => {
    // ── TURN 1: User engages with symptoms → transitions presentation → intake ──
    const turn1 = await core.eventRouter.handleEvent({
      type: 'conversation',
      journey_id: ji.id,
      payload: { text: 'I have been really tired and gaining weight lately' }
    });

    assert.equal(turn1.handled, true);
    assert.equal(turn1.transitioned, true);
    assert.equal(turn1.newBlock, 'simple_intake');

    let ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'simple_intake');
    assert.equal(ctx.presentation.engaged, true);

    // ── TURN 2: User provides name → stays in intake (missing email) ──
    const turn2 = await core.eventRouter.handleEvent({
      type: 'conversation',
      journey_id: ji.id,
      payload: { text: 'Jane Smith' }
    });

    assert.equal(turn2.handled, true);
    assert.equal(turn2.transitioned, false);
    assert.equal(turn2.newBlock, 'simple_intake');

    ctx = core.context.read(ji.id);
    assert.equal(ctx.simple_intake.customerName, 'Jane Smith');

    // ── TURN 3: User provides email → completes intake → transitions to recommendation ──
    const turn3 = await core.eventRouter.handleEvent({
      type: 'conversation',
      journey_id: ji.id,
      payload: { text: 'jane@example.com' }
    });

    assert.equal(turn3.handled, true);
    assert.equal(turn3.transitioned, true);
    assert.equal(turn3.newBlock, 'recommendation');

    ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'recommendation');
    assert.equal(ctx.simple_intake.customerEmail, 'jane@example.com');

    // ── TURN 4: User agrees to recommendation ──
    const turn4a = await core.eventRouter.handleEvent({
      type: 'conversation',
      journey_id: ji.id,
      payload: { text: 'Yes, sounds perfect, let\'s do it' }
    });

    // LLM extracts agreed: true, but consent_recorded not yet set → stays in recommendation
    assert.equal(turn4a.handled, true);
    ctx = core.context.read(ji.id);
    assert.equal(ctx.recommendation.agreed, true);

    // Consumer layer records consent (simulated here)
    core.context.update(ji.id, { 'recommendation.consent_recorded': true });

    // ── TURN 4b: Next message triggers completion check → transitions to payment ──
    const turn4b = await core.eventRouter.handleEvent({
      type: 'conversation',
      journey_id: ji.id,
      payload: { text: 'Great, let\'s proceed' }
    });

    assert.equal(turn4b.transitioned, true);
    assert.equal(turn4b.newBlock, 'payment');

    ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'payment');

    // Simulate checkout creation (would normally happen via capability on block entry)
    core.context.update(ji.id, {
      'payment.order_id': 'SQ-001',
      'payment.status': 'pending',
      'payment.checkout_url': 'https://square.link/pay/SQ-001'
    });

    // ── TURN 5: Payment webhook → completes journey ──
    const turn5 = await core.eventRouter.handleEvent({
      type: 'api',
      journey_id: ji.id,
      source: 'square_webhook',
      payload: { status: 'completed', order_id: 'SQ-001', amount_cents: 14900 }
    });

    assert.equal(turn5.handled, true);

    ctx = core.context.read(ji.id);
    assert.equal(ctx.payment.status, 'completed');
    assert.equal(ctx.journey_status, 'completed');

    // ── Verify full event log ──
    const events = core.db.eventsLog.findByJourney(ji.id);
    assert.ok(events.length >= 5, `Expected at least 5 events, got ${events.length}`);

    // ── Verify block history ──
    assert.ok(ctx.block_history.length >= 4);
    assert.equal(ctx.block_history[0].block, 'presentation');
    assert.ok(ctx.block_history[0].exited); // exited
  });

  it('payment failure keeps journey in payment block', async () => {
    // Fast-forward to payment block
    core.context.update(ji.id, {
      current_block: 'payment',
      'payment.order_id': 'SQ-002',
      'payment.status': 'pending'
    });

    const result = await core.eventRouter.handleEvent({
      type: 'api',
      journey_id: ji.id,
      source: 'square_webhook',
      payload: { status: 'failed' }
    });

    assert.equal(result.handled, true);
    assert.equal(result.transitioned, false);

    const ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'payment');
    assert.equal(ctx.payment.status, 'failed');
  });

  it('ignores events after journey completion', async () => {
    // Complete the journey
    core.context.update(ji.id, { journey_status: 'completed' });
    core.db.journeyInstances.put(ji.id, {
      context: core.context.read(ji.id),
      status: 'completed'
    });

    const result = await core.eventRouter.handleEvent({
      type: 'conversation',
      journey_id: ji.id,
      payload: { text: 'hello again' }
    });

    assert.equal(result.handled, false);
    assert.equal(result.reason, 'journey_not_active');
  });
});
