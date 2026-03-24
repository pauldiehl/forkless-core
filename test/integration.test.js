/**
 * Integration tests — validates that createCore() wires all modules correctly
 * and that the full lifecycle works end-to-end.
 *
 * These tests exercise real DB, real context manager, real action dispatcher,
 * and real capability registry together. No mocks.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createCore } = require('../index');

describe('integration: createCore full lifecycle', () => {
  let core;

  beforeEach(() => {
    core = createCore({ dbPath: ':memory:' });
  });

  afterEach(() => {
    core.close();
  });

  it('user → journey → context → respond → message persisted', async () => {
    // Create user
    const user = core.db.users.create({ email: 'jane@example.com', name: 'Jane Doe' });
    assert.ok(user.id);
    assert.equal(user.email, 'jane@example.com');

    // Create conversation
    const convo = core.db.conversations.create({
      user_id: user.id,
      mode: 'agent'
    });
    assert.ok(convo.id);

    // Create journey instance with initial context
    const initCtx = core.context.create({
      journey_type: 'medical_consult',
      user_id: user.id,
      conversation_id: convo.id,
      initialBlock: 'simple_intake'
    });

    const ji = core.db.journeyInstances.create({
      user_id: user.id,
      journey_type: 'medical_consult',
      context: initCtx
    });
    assert.ok(ji.id);
    assert.equal(ji.context.current_block, 'simple_intake');
    assert.equal(ji.context.conversation_id, convo.id);

    // Update context via context manager (simulating intake collection)
    core.context.update(ji.id, {
      'intake.customerName': 'Jane Doe',
      'intake.customerEmail': 'jane@example.com',
      'intake.symptoms': 'fatigue, weight gain'
    });

    const ctx = core.context.read(ji.id);
    assert.equal(ctx.intake.customerName, 'Jane Doe');
    assert.equal(ctx.intake.symptoms, 'fatigue, weight gain');

    // Dispatch a respond action with template — should resolve and persist
    const respondResult = await core.actionDispatcher.dispatch(
      { type: 'respond', template: 'Hello {{intake.customerName}}, we received your symptoms: {{intake.symptoms}}.' },
      ctx,
      {}
    );

    assert.equal(respondResult.sent, true);
    assert.ok(respondResult.text.includes('Jane Doe'));
    assert.ok(respondResult.text.includes('fatigue, weight gain'));

    // Verify message was persisted in conversation
    const updatedConvo = core.db.conversations.get(convo.id);
    assert.equal(updatedConvo.messages.length, 1);
    assert.equal(updatedConvo.messages[0].role, 'agent');
    assert.ok(updatedConvo.messages[0].text.includes('Jane Doe'));
  });

  it('capability registration → dispatch execute_capability → result returned', async () => {
    const user = core.db.users.create({ email: 'cap@test.com' });
    const ji = core.db.journeyInstances.create({
      user_id: user.id,
      journey_type: 'test',
      context: { current_block: 'payment' }
    });

    // Register a mock capability
    core.capabilityRegistry.register('square_checkout', {
      execute: async (params, context) => ({
        order_id: 'SQ-001',
        checkout_url: `https://square.link/${params.product_slug}`,
        status: 'created'
      })
    });

    assert.ok(core.capabilityRegistry.has('square_checkout'));

    // Dispatch through action dispatcher
    const result = await core.actionDispatcher.dispatch(
      {
        type: 'execute_capability',
        capability: 'square_checkout',
        params: { product_slug: 'hormone-panel', amount_cents: 19900 }
      },
      ji.context,
      {}
    );

    assert.equal(result.order_id, 'SQ-001');
    assert.ok(result.checkout_url.includes('hormone-panel'));
    assert.equal(result.status, 'created');
  });

  it('validate action works with real context data', async () => {
    const user = core.db.users.create({ email: 'val@test.com' });
    const ji = core.db.journeyInstances.create({
      user_id: user.id,
      journey_type: 'test',
      context: { intake: { customerEmail: 'val@test.com', customerName: '' } }
    });

    // Should fail — customerName is empty
    const failResult = await core.actionDispatcher.dispatch(
      {
        type: 'validate',
        rules: [
          { field: 'intake.customerName', required: true },
          { field: 'intake.customerEmail', required: true, pattern: '^.+@.+\\..+$' }
        ]
      },
      ji.context,
      {}
    );
    assert.equal(failResult.valid, false);
    assert.ok(failResult.reason.includes('customerName'));

    // Fix context and retry
    core.context.update(ji.id, { 'intake.customerName': 'Jane' });
    const fixedCtx = core.context.read(ji.id);

    const passResult = await core.actionDispatcher.dispatch(
      {
        type: 'validate',
        rules: [
          { field: 'intake.customerName', required: true },
          { field: 'intake.customerEmail', required: true, pattern: '^.+@.+\\..+$' }
        ]
      },
      fixedCtx,
      {}
    );
    assert.equal(passResult.valid, true);
  });

  it('transaction_note persists to conversation as transaction role', async () => {
    const user = core.db.users.create({ email: 'txn@test.com' });
    const convo = core.db.conversations.create({ user_id: user.id });
    const ji = core.db.journeyInstances.create({
      user_id: user.id,
      journey_type: 'test',
      context: {
        conversation_id: convo.id,
        payment: { order_id: 'SQ-001', amount: '$199.00' }
      }
    });

    await core.actionDispatcher.dispatch(
      { type: 'transaction_note', template: 'Payment {{payment.order_id}} received for {{payment.amount}}.' },
      ji.context,
      {}
    );

    const updated = core.db.conversations.get(convo.id);
    assert.equal(updated.messages.length, 1);
    assert.equal(updated.messages[0].role, 'transaction');
    assert.ok(updated.messages[0].text.includes('SQ-001'));
    assert.ok(updated.messages[0].text.includes('$199.00'));
  });

  it('snapshot and restore preserves full context through DB', () => {
    const user = core.db.users.create({ email: 'snap@test.com' });
    const initCtx = core.context.create({
      journey_type: 'medical_consult',
      user_id: user.id,
      initialBlock: 'payment'
    });
    const ji = core.db.journeyInstances.create({
      user_id: user.id,
      journey_type: 'medical_consult',
      context: initCtx
    });

    // Build up some context
    core.context.update(ji.id, {
      'intake.customerName': 'Jane',
      'payment.status': 'pending',
      'payment.order_id': 'SQ-001'
    });

    // Snapshot
    const snap = core.context.snapshot(ji.id);
    assert.equal(snap.context.payment.status, 'pending');

    // Mutate past the snapshot point
    core.context.update(ji.id, { 'payment.status': 'completed', 'payment.completed_at': '2026-03-24' });
    assert.equal(core.context.read(ji.id).payment.status, 'completed');

    // Restore — should revert to pending
    core.context.restore(ji.id, snap);
    const restored = core.context.read(ji.id);
    assert.equal(restored.payment.status, 'pending');
    assert.equal(restored.payment.order_id, 'SQ-001');
    assert.equal(restored.payment.completed_at, undefined);
  });

  it('events log captures journey events', () => {
    const user = core.db.users.create({ email: 'evt@test.com' });
    const ji = core.db.journeyInstances.create({
      user_id: user.id,
      journey_type: 'test',
      context: {}
    });

    // Log a series of events
    core.db.eventsLog.put({
      journey_instance_id: ji.id,
      type: 'conversation',
      source: 'customer',
      payload: { text: 'I want hormone testing' }
    });
    core.db.eventsLog.put({
      journey_instance_id: ji.id,
      type: 'api',
      source: 'square_webhook',
      payload: { order_id: 'SQ-001', status: 'completed' }
    });
    core.db.eventsLog.put({
      journey_instance_id: ji.id,
      type: 'system',
      source: 'block_executor',
      payload: { transition: 'simple_intake → payment' }
    });

    // Query all events
    const all = core.db.eventsLog.findByJourney(ji.id);
    assert.equal(all.length, 3);

    // Filter by type
    const apiOnly = core.db.eventsLog.findByJourney(ji.id, { type: 'api' });
    assert.equal(apiOnly.length, 1);
    assert.equal(apiOnly[0].payload.order_id, 'SQ-001');
  });

  it('business records attach to journey', () => {
    const user = core.db.users.create({ email: 'br@test.com' });
    const ji = core.db.journeyInstances.create({
      user_id: user.id,
      journey_type: 'medical_consult',
      context: {}
    });

    core.db.businessRecords.create({
      journey_instance_id: ji.id,
      record_type: 'lab_order',
      data: { provider: 'labcorp', test_type: 'hormone_panel', requisition_id: 'LC-9001' }
    });
    core.db.businessRecords.create({
      journey_instance_id: ji.id,
      record_type: 'payment_receipt',
      data: { provider: 'square', order_id: 'SQ-001', amount_cents: 19900 }
    });

    const all = core.db.businessRecords.findByJourney(ji.id);
    assert.equal(all.length, 2);

    const labOnly = core.db.businessRecords.findByJourney(ji.id, { record_type: 'lab_order' });
    assert.equal(labOnly.length, 1);
    assert.equal(labOnly[0].data.requisition_id, 'LC-9001');
  });

  it('multi-action sequence mimics real block execution', async () => {
    // This simulates what a block executor would do:
    // validate → execute_capability → update_context → transaction_note → respond

    const user = core.db.users.create({ email: 'multi@test.com', name: 'Jane' });
    const convo = core.db.conversations.create({ user_id: user.id });
    const initCtx = core.context.create({
      journey_type: 'medical_consult',
      user_id: user.id,
      conversation_id: convo.id,
      initialBlock: 'payment'
    });
    // Pre-populate intake data (as if prior blocks ran)
    initCtx.intake = { customerName: 'Jane', customerEmail: 'jane@example.com' };
    initCtx.recommendation = { agreed: true, product: 'hormone_panel' };

    const ji = core.db.journeyInstances.create({
      user_id: user.id,
      journey_type: 'medical_consult',
      context: initCtx
    });

    core.capabilityRegistry.register('square_checkout', {
      execute: async (params) => ({
        order_id: 'SQ-999',
        checkout_url: `https://square.link/${params.product_slug}`,
        status: 'created'
      })
    });

    let ctx = core.context.read(ji.id);

    // Step 1: Validate prerequisites
    const validation = await core.actionDispatcher.dispatch(
      {
        type: 'validate',
        rules: [
          { field: 'intake.customerName', required: true },
          { field: 'intake.customerEmail', required: true },
          { field: 'recommendation.agreed', required: true }
        ]
      },
      ctx, {}
    );
    assert.equal(validation.valid, true);

    // Step 2: Execute capability
    const capResult = await core.actionDispatcher.dispatch(
      {
        type: 'execute_capability',
        capability: 'square_checkout',
        params: { product_slug: 'hormone-panel', amount_cents: 19900 }
      },
      ctx, {}
    );
    assert.equal(capResult.order_id, 'SQ-999');

    // Step 3: Update context with capability result
    core.context.update(ji.id, {
      'payment.order_id': capResult.order_id,
      'payment.checkout_url': capResult.checkout_url,
      'payment.status': capResult.status
    });
    ctx = core.context.read(ji.id);
    assert.equal(ctx.payment.order_id, 'SQ-999');

    // Step 4: Transaction note
    await core.actionDispatcher.dispatch(
      { type: 'transaction_note', template: 'Checkout created: {{payment.order_id}}' },
      ctx, {}
    );

    // Step 5: Respond to customer
    await core.actionDispatcher.dispatch(
      { type: 'respond', template: 'Hi {{intake.customerName}}, your checkout is ready: {{payment.checkout_url}}' },
      ctx, {}
    );

    // Verify final state
    const finalConvo = core.db.conversations.get(convo.id);
    assert.equal(finalConvo.messages.length, 2);
    assert.equal(finalConvo.messages[0].role, 'transaction');
    assert.equal(finalConvo.messages[1].role, 'agent');
    assert.ok(finalConvo.messages[1].text.includes('square.link/hormone-panel'));

    const finalCtx = core.context.read(ji.id);
    assert.equal(finalCtx.payment.status, 'created');
    assert.equal(finalCtx.intake.customerName, 'Jane');
  });
});
