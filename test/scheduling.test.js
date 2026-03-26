const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCore } = require('../index');

describe('followup block on_enter scheduling', () => {
  it('fetches slots and formats display on entry', async () => {
    const core = createCore({ useMockLLM: true });

    core.capabilityRegistry.register('scheduling_get_slots', {
      execute: async (params) => ({
        slots: [
          { datetime: '2026-04-01T14:30:00Z', display: 'Tuesday Apr 1, 2:30 PM' },
          { datetime: '2026-04-02T10:00:00Z', display: 'Wednesday Apr 2, 10:00 AM' }
        ],
        event_type: params.event_type || 'consultation'
      })
    });

    core.registerJourney({
      journey_type: 'sched_test',
      blocks: [
        { block: 'payment', params: { amount_cents: 100, product_slug: 'x', provider: 'square' } },
        { block: 'followup', params: { include_scheduling: true, cal_event_type: 'medical-consult' } }
      ]
    });

    const user = core.db.users.create({ email: 'sched@test.com' });
    const initCtx = core.context.create({ journey_type: 'sched_test', user_id: user.id, initialBlock: 'payment' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'sched_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id, 'payment.order_id': 'sq_1', 'payment.status': 'pending' });

    // Payment webhook → transitions to followup → on_enter fires
    await core.eventRouter.handleEvent({
      type: 'api', journey_id: ji.id, source: 'square_webhook',
      payload: { status: 'completed', order_id: 'sq_1' }
    });

    const ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'followup');

    // Verify slots were fetched and formatted
    assert.ok(ctx.followup.slots, 'should have slots from capability');
    assert.equal(ctx.followup.slots.length, 2);
    assert.ok(ctx.followup.available_slots_display, 'should have formatted display');
    assert.ok(ctx.followup.available_slots_display.includes('Tuesday Apr 1'));
    assert.equal(ctx.followup.scheduling_offered, true);

    // Verify response message was sent
    const msgs = core.db.conversations.get(convo.id).messages;
    const schedMsg = msgs.find(m => m.text && m.text.includes('schedule'));
    assert.ok(schedMsg, 'should have scheduling message');
    assert.ok(schedMsg.text.includes('Tuesday Apr 1'));

    core.close();
  });

  it('handles missing scheduling capability gracefully', async () => {
    const core = createCore({ useMockLLM: true });
    // Don't register scheduling_get_slots

    core.registerJourney({
      journey_type: 'no_sched_test',
      blocks: [
        { block: 'payment', params: { amount_cents: 100, product_slug: 'x', provider: 'square' } },
        { block: 'followup', params: { include_scheduling: true, cal_event_type: 'consult' } }
      ]
    });

    const user = core.db.users.create({ email: 'nosched@test.com' });
    const initCtx = core.context.create({ journey_type: 'no_sched_test', user_id: user.id, initialBlock: 'payment' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'no_sched_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id, 'payment.order_id': 'sq_2', 'payment.status': 'pending' });

    // Should transition to followup even if scheduling capability is missing
    await core.eventRouter.handleEvent({
      type: 'api', journey_id: ji.id, source: 'square_webhook',
      payload: { status: 'completed', order_id: 'sq_2' }
    });

    const ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'followup');
    core.close();
  });

  it('meeting_ended webhook on followup triggers next_block transition', async () => {
    const core = createCore({ useMockLLM: true });
    // Add a block after followup to transition to
    const postMeetBlock = {
      type: 'conversational', name: 'post_meet',
      params_schema: {}, reads: [], writes: [],
      handles_events: ['conversation'],
      checkCompletion() { return false; }
    };

    const core2 = createCore({ useMockLLM: true, extraBlocks: [postMeetBlock] });
    core2.registerJourney({
      journey_type: 'meeting_test',
      blocks: [
        { block: 'followup', params: { include_scheduling: true } },
        { block: 'post_meet', params: {} }
      ]
    });

    const user = core2.db.users.create({ email: 'meeting@test.com' });
    const initCtx = core2.context.create({ journey_type: 'meeting_test', user_id: user.id, initialBlock: 'followup' });
    initCtx.journey_status = 'in_progress';
    const ji = core2.db.journeyInstances.create({ user_id: user.id, journey_type: 'meeting_test', context: initCtx, status: 'in_progress' });
    const convo = core2.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core2.context.update(ji.id, { conversation_id: convo.id });

    // meeting_ended webhook → transitions to post_meet
    await core2.eventRouter.handleEvent({
      type: 'api', journey_id: ji.id, source: 'calcom_webhook',
      payload: { triggerEvent: 'MEETING_ENDED' }
    });

    const ctx = core2.context.read(ji.id);
    assert.equal(ctx.current_block, 'post_meet');
    assert.equal(ctx.followup.meeting_completed, true);

    core.close();
    core2.close();
  });
});
