const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCore } = require('../index');

describe('recommendation consent flow', () => {
  let core;
  const journeyDef = {
    journey_type: 'consent_test',
    blocks: [
      { block: 'recommendation', params: { price_cents: 14900 } },
      { block: 'payment', params: { amount_cents: 14900, product_slug: 'test', provider: 'square' } }
    ]
  };

  beforeEach(() => {
    core = createCore({ useMockLLM: true });
    core.registerJourney(journeyDef);
  });

  function setupJourney() {
    const user = core.db.users.create({ email: `consent-${Date.now()}@test.com` });
    const initCtx = core.context.create({ journey_type: 'consent_test', user_id: user.id, initialBlock: 'recommendation' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'consent_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id });
    return { user, ji, convo };
  }

  it('does NOT transition when agreed but consent_recorded is missing', async () => {
    const { ji } = setupJourney();

    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id,
      payload: { text: 'Yes sounds great' }
    });

    const ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'recommendation', 'should stay in recommendation');
    assert.equal(ctx.recommendation.agreed, true, 'agreed should be set');
    assert.notEqual(ctx.recommendation.consent_recorded, true, 'consent_recorded should NOT be auto-set');

    core.close();
  });

  it('transitions when both agreed AND consent_recorded are true', async () => {
    const { ji } = setupJourney();

    // Step 1: User agrees
    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id,
      payload: { text: 'Yes let\'s do it' }
    });

    let ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'recommendation');
    assert.equal(ctx.recommendation.agreed, true);

    // Step 2: Consumer records consent (simulated)
    core.context.update(ji.id, { 'recommendation.consent_recorded': true });

    // Step 3: Next message triggers completion → transitions to payment
    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id,
      payload: { text: 'Ready to pay' }
    });

    ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'payment', 'should transition to payment');

    core.close();
  });

  it('consent_recorded without agreed does not transition', async () => {
    const { ji } = setupJourney();

    // Set consent_recorded without agreed
    core.context.update(ji.id, { 'recommendation.consent_recorded': true });

    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id,
      payload: { text: 'tell me more about this' }
    });

    const ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'recommendation', 'should stay in recommendation');

    core.close();
  });

  it('business_record creation by consumer is a context-only operation', async () => {
    const { ji, user } = setupJourney();

    // Simulate consumer creating a consent business_record
    const record = core.db.businessRecords.create({
      journey_instance_id: ji.id,
      record_type: 'consent',
      data: {
        agreement_text: 'Medical consultation + lab panel — $149.00',
        user_email: user.email,
        consented_at: new Date().toISOString()
      }
    });

    assert.ok(record.id);
    assert.equal(record.record_type, 'consent');
    assert.ok(record.data.agreement_text);
    assert.ok(record.data.consented_at);

    // Verify it can be retrieved
    const records = core.db.businessRecords.findByJourney(ji.id, { record_type: 'consent' });
    assert.equal(records.length, 1);
    assert.equal(records[0].data.user_email, user.email);

    core.close();
  });
});
