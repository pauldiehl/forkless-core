const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCore } = require('../index');

describe('on_enter block actions', () => {
  let core;

  beforeEach(() => {
    core = createCore({ useMockLLM: true });
  });

  it('fires on_enter actions when transitioning to a block with on_enter', async () => {
    // Register mock capability
    core.capabilityRegistry.register('square_create_checkout', {
      execute: async (params) => ({
        order_id: `sq_test_${Date.now()}`,
        checkout_url: 'https://square.link/test',
        amount_cents: params.amount_cents,
        status: 'pending'
      })
    });

    const journeyDef = {
      journey_type: 'on_enter_test',
      blocks: [
        { block: 'recommendation', params: { price_cents: 14900 } },
        { block: 'payment', params: { amount_cents: 14900, product_slug: 'test', provider: 'square' } }
      ]
    };
    core.registerJourney(journeyDef);

    const user = core.db.users.create({ email: 'enter@test.com' });
    const initCtx = core.context.create({ journey_type: 'on_enter_test', user_id: user.id, initialBlock: 'recommendation' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'on_enter_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id });

    // User agrees → transitions to payment → on_enter fires
    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id,
      payload: { text: 'Yes let\'s do it' }
    });

    const ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'payment');

    // Verify on_enter capability result merged into context
    assert.ok(ctx.payment.order_id, 'order_id should be set from capability');
    assert.ok(ctx.payment.checkout_url, 'checkout_url should be set from capability');
    assert.equal(ctx.payment.status, 'pending', 'status should be set from update_context');
    assert.ok(ctx.payment.price_display, 'price_display should be computed');

    // Verify respond action sent a message with the checkout link
    const msgs = core.db.conversations.get(convo.id).messages;
    const checkoutMsg = msgs.find(m => m.text && m.text.includes('payment link'));
    assert.ok(checkoutMsg, 'should have a checkout link message');
    assert.ok(checkoutMsg.text.includes(ctx.payment.checkout_url), 'message should include the checkout URL');

    core.close();
  });

  it('blocks without on_enter are unaffected', async () => {
    const journeyDef = {
      journey_type: 'no_enter_test',
      blocks: [
        { block: 'presentation', params: { offering_slug: 'test' } },
        { block: 'simple_intake', params: { required_fields: ['customerName'] } }
      ]
    };
    core.registerJourney(journeyDef);

    const user = core.db.users.create({ email: 'noenter@test.com' });
    const initCtx = core.context.create({ journey_type: 'no_enter_test', user_id: user.id, initialBlock: 'presentation' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'no_enter_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id });

    // Engage → transition to intake (no on_enter)
    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id,
      payload: { text: 'I am so tired and gaining weight' }
    });

    const ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'simple_intake');
    // No crash, no unexpected context additions
    assert.ok(!ctx.simple_intake?.order_id);

    core.close();
  });

  it('on_enter capability failure does not crash the transition', async () => {
    // Register a failing capability
    core.capabilityRegistry.register('square_create_checkout', {
      execute: async () => { throw new Error('Square API unavailable'); }
    });

    const journeyDef = {
      journey_type: 'fail_enter_test',
      blocks: [
        { block: 'recommendation', params: { price_cents: 14900 } },
        { block: 'payment', params: { amount_cents: 14900, product_slug: 'test', provider: 'square' } }
      ]
    };
    core.registerJourney(journeyDef);

    const user = core.db.users.create({ email: 'fail@test.com' });
    const initCtx = core.context.create({ journey_type: 'fail_enter_test', user_id: user.id, initialBlock: 'recommendation' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'fail_enter_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id });

    // Should transition to payment even though on_enter fails
    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id,
      payload: { text: 'Yes let\'s do it' }
    });

    const ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'payment');
    // Capability failed, so no order_id — but status may still be set from update_context
    assert.equal(ctx.payment.status, 'pending');

    core.close();
  });

  it('on_enter fires for capability blocks on api event transitions', async () => {
    // lab_processing has on_enter in its internal_states (not the block contract itself)
    // But followup doesn't have on_enter. Let's test with a custom block that has on_enter.
    const customBlock = {
      type: 'conversational', name: 'post_payment',
      params_schema: {}, reads: [], writes: ['post_payment.*'],
      handles_events: ['conversation'],
      on_conversation_event: { completion_condition: null },
      on_enter: [
        { type: 'update_context', set: { 'post_payment.entered': true } }
      ],
      checkCompletion() { return false; }
    };

    const core2 = createCore({ useMockLLM: true, extraBlocks: [customBlock] });
    core2.registerJourney({
      journey_type: 'enter_api_test',
      blocks: [
        { block: 'payment', params: { amount_cents: 100, product_slug: 'x', provider: 'square' } },
        { block: 'post_payment', params: {} }
      ]
    });

    const user = core2.db.users.create({ email: 'api_enter@test.com' });
    const initCtx = core2.context.create({ journey_type: 'enter_api_test', user_id: user.id, initialBlock: 'payment' });
    initCtx.journey_status = 'in_progress';
    const ji = core2.db.journeyInstances.create({ user_id: user.id, journey_type: 'enter_api_test', context: initCtx, status: 'in_progress' });
    const convo = core2.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core2.context.update(ji.id, { conversation_id: convo.id, 'payment.order_id': 'sq_1', 'payment.status': 'pending' });

    // Fire payment_completed webhook → transitions to post_payment → on_enter fires
    await core2.eventRouter.handleEvent({
      type: 'api', journey_id: ji.id, source: 'square_webhook',
      payload: { status: 'completed', order_id: 'sq_1' }
    });

    const ctx = core2.context.read(ji.id);
    assert.equal(ctx.current_block, 'post_payment');
    assert.equal(ctx.post_payment.entered, true, 'on_enter should have fired');

    core2.close();
  });

  it('on_enter merges capability result into block namespace', async () => {
    core.capabilityRegistry.register('square_create_checkout', {
      execute: async (params) => ({
        order_id: 'sq_merge_test',
        checkout_url: 'https://square.link/merge',
        amount_cents: params.amount_cents,
        extra_field: 'bonus_data'
      })
    });

    const journeyDef = {
      journey_type: 'merge_test',
      blocks: [
        { block: 'recommendation', params: { price_cents: 9900 } },
        { block: 'payment', params: { amount_cents: 9900, product_slug: 'test', provider: 'square' } }
      ]
    };
    core.registerJourney(journeyDef);

    const user = core.db.users.create({ email: 'merge@test.com' });
    const initCtx = core.context.create({ journey_type: 'merge_test', user_id: user.id, initialBlock: 'recommendation' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'merge_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id });

    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id,
      payload: { text: 'Yes let\'s proceed' }
    });

    const ctx = core.context.read(ji.id);
    assert.equal(ctx.payment.order_id, 'sq_merge_test');
    assert.equal(ctx.payment.checkout_url, 'https://square.link/merge');
    assert.equal(ctx.payment.extra_field, 'bonus_data', 'extra capability fields should merge');
    assert.equal(ctx.payment.price_display, '$99.00', 'price_display should be computed');

    core.close();
  });
});
