/**
 * Edge-case tests for payment and lab_processing blocks.
 *
 * Tests the ugly stuff: wrong order IDs, out-of-sequence webhooks,
 * missing required context, unknown payload statuses, garbage data.
 *
 * These are the events the real world will send you.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { teleport, teleportSequence } = require('./teleport');

const labsOnly = require('./fixtures/labs-only.json');

// ──────────────────────────────────────────
// PAYMENT BLOCK — EDGE CASES
// ──────────────────────────────────────────

describe('payment: edge cases', () => {

  it('webhook with unknown status is ignored (not completed, not failed)', async () => {
    // Square sends statuses like "pending", "refunded", "disputed" —
    // payment block only handles "completed" and "failed"
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'payment',
      event: {
        type: 'api',
        source: 'square_webhook',
        payload: { status: 'refunded', order_id: 'sq_001' }
      }
    });

    // getApiHandler returns null for unknown status → no handler → not handled
    assert.equal(result.context.current_block, 'payment', 'should stay in payment');
    assert.notEqual(result.context.payment?.status, 'refunded', 'should not write unknown status to context');
    result.core.close();
  });

  it('payment_completed webhook when payment.order_id is missing from context', async () => {
    // Webhook arrives but context was never populated with an order_id.
    // The before-action validate should catch this.
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'payment',
      event: {
        type: 'api',
        source: 'square_webhook',
        payload: { status: 'completed', order_id: 'sq_001' }
      },
      // Explicitly wipe the order_id that seed may have set
      contextOverrides: { 'payment.order_id': null }
    });

    // Validation should fail → no transition
    assert.equal(result.context.current_block, 'payment', 'should stay in payment');
    assert.equal(result.result.transitioned, false, 'should not transition');
    assert.ok(result.result.error, 'should have a validation error');
    assert.ok(result.result.error.includes('order_id'), 'error should mention order_id');
    result.core.close();
  });

  it('payment_completed webhook when payment.order_id exists → transitions normally', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'payment',
      event: {
        type: 'api',
        source: 'square_webhook',
        payload: { status: 'completed', order_id: 'sq_valid_001' }
      },
      contextOverrides: { 'payment.order_id': 'sq_valid_001' }
    });

    assert.equal(result.result.transitioned, true, 'should transition');
    assert.equal(result.context.current_block, 'lab_processing', 'should move to lab_processing');
    assert.equal(result.context.payment.status, 'completed');
    result.core.close();
  });

  it('payment_failed then payment_completed recovers correctly', async () => {
    // Simulate: first attempt fails, second succeeds
    const { results, core } = await teleportSequence({
      journeyDef: labsOnly,
      atBlock: 'payment',
      events: [
        // First: payment fails
        { type: 'api', source: 'square_webhook', payload: { status: 'failed' } },
        // Second: customer retries, payment succeeds
        { type: 'api', source: 'square_webhook', payload: { status: 'completed', order_id: 'sq_retry_001' } }
      ],
      contextOverrides: { 'payment.order_id': 'sq_retry_001' }
    });

    // After first event: still in payment, status = failed
    assert.equal(results[0].context.current_block, 'payment');
    assert.equal(results[0].context.payment.status, 'failed');

    // After second event: transitioned, status = completed
    assert.equal(results[1].context.current_block, 'lab_processing');
    assert.equal(results[1].context.payment.status, 'completed');
    core.close();
  });

  it('conversation event while waiting for payment webhook', async () => {
    // Customer sends a message like "how long will this take?" while
    // the block is waiting for a payment webhook
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'payment',
      event: {
        type: 'conversation',
        payload: { text: 'How long does payment take?' }
      }
    });

    // Should stay in payment — conversation events on capability blocks
    // don't trigger transitions
    assert.equal(result.context.current_block, 'payment');
    assert.equal(result.result.transitioned, false);
    result.core.close();
  });

  it('completely empty payload on api event', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'payment',
      event: {
        type: 'api',
        source: 'square_webhook',
        payload: {}
      }
    });

    // No status → getApiHandler returns null → no handler → no transition
    assert.equal(result.context.current_block, 'payment');
    assert.equal(result.result.transitioned, false);
    result.core.close();
  });

  it('scheduled event that payment block does not handle', async () => {
    // A scheduled event fires but payment doesn't declare on_scheduled_event
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'payment',
      event: {
        type: 'scheduled',
        payload: { job_type: 'payment_reminder' }
      }
    });

    // Block doesn't handle 'scheduled' events → ignored
    assert.equal(result.context.current_block, 'payment');
    assert.equal(result.result.transitioned, false);
    result.core.close();
  });
});

// ──────────────────────────────────────────
// LAB PROCESSING BLOCK — EDGE CASES
// ──────────────────────────────────────────

describe('lab_processing: edge cases', () => {

  it('results_ready webhook when lab_order_id is missing from context', async () => {
    // Webhook says results are ready but we never stored a lab_order_id
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'api',
        source: 'labcorp_webhook',
        payload: { labcorp_status: 'results_ready' }
      },
      contextOverrides: { 'lab_processing.lab_order_id': null }
    });

    // Before-action validate should catch missing lab_order_id
    assert.equal(result.context.current_block, 'lab_processing', 'should stay in block');
    assert.equal(result.result.transitioned, false);
    assert.ok(result.result.error, 'should have validation error');
    assert.ok(result.result.error.includes('lab_order_id'), 'error should mention lab_order_id');
    result.core.close();
  });

  it('out-of-sequence: results_ready skipping intermediate states', async () => {
    // Lab goes straight from pending to results_ready (skipping awaiting_lab_visit
    // and lab_results_pending). Real world: lab processes fast, or status updates
    // were missed/batched.
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'api',
        source: 'labcorp_webhook',
        payload: { labcorp_status: 'results_ready', lab_order_id: 'lab_skip_001' }
      },
      contextOverrides: {
        'lab_processing.lab_order_id': 'lab_skip_001',
        'block_state': 'lab_order_pending'  // explicitly at earliest state
      }
    });

    // results_ready is an exit state → should transition to followup
    // regardless of what internal state we were in
    assert.equal(result.context.current_block, 'followup', 'should transition to followup');
    assert.equal(result.result.transitioned, true);
    result.core.close();
  });

  it('intermediate status update: awaiting_lab_visit', async () => {
    // A normal intermediate update — not an exit state
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'api',
        source: 'labcorp_webhook',
        payload: { labcorp_status: 'awaiting_lab_visit' }
      },
      contextOverrides: {
        'lab_processing.lab_order_id': 'lab_int_001',
        'block_state': 'lab_order_pending'
      }
    });

    // Should update block_state but NOT transition to next block
    assert.equal(result.context.current_block, 'lab_processing', 'should stay in lab_processing');
    assert.equal(result.context.block_state, 'awaiting_lab_visit', 'should update internal state');
    // Should have a transaction note about the status change
    const txnNotes = result.messages.filter(m => m.role === 'transaction');
    assert.ok(txnNotes.length > 0, 'should log a transaction note');
    result.core.close();
  });

  it('unknown labcorp_status value', async () => {
    // Labcorp sends a status we don't recognize
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'api',
        source: 'labcorp_webhook',
        payload: { labcorp_status: 'specimen_in_transit' }
      },
      contextOverrides: {
        'lab_processing.lab_order_id': 'lab_unk_001'
      }
    });

    // getApiHandler returns 'lab_status_update' for any non-empty labcorp_status
    // that isn't 'results_ready'. The transition is 'derived_from_payload.labcorp_status'
    // → 'specimen_in_transit', which is NOT a declared internal_state.
    // Block executor should reject the undeclared state: stay in block, don't update
    // block_state, and return a warning. The event is still logged (audit trail).
    assert.equal(result.context.current_block, 'lab_processing', 'should stay in block');
    assert.notEqual(result.context.block_state, 'specimen_in_transit', 'should NOT set block_state to undeclared state');
    assert.ok(result.result.warning, 'should have a warning');
    assert.ok(result.result.warning.includes('specimen_in_transit'), 'warning should name the unrecognized state');
    result.core.close();
  });

  it('api event with no labcorp_status at all', async () => {
    // Garbage webhook — has a source but no recognizable payload
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'api',
        source: 'labcorp_webhook',
        payload: { some_random_field: 'garbage' }
      }
    });

    // getApiHandler checks payload.labcorp_status → undefined → returns null
    // No handler → event is ignored
    assert.equal(result.context.current_block, 'lab_processing');
    assert.equal(result.result.transitioned, false);
    result.core.close();
  });

  it('scheduled reminder does not cause transition', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'scheduled',
        payload: { job_type: 'lab_visit_reminder' }
      }
    });

    assert.equal(result.context.current_block, 'lab_processing', 'should stay in block');
    assert.equal(result.result.transitioned, false, 'reminder should not transition');
    // But should produce a response message
    const agentMessages = result.messages.filter(m => m.role === 'agent');
    assert.ok(agentMessages.length > 0, 'should send reminder message');
    assert.ok(
      agentMessages.some(m => m.text.includes('lab') || m.text.includes('visit') || m.text.includes('blood')),
      'reminder should mention lab visit'
    );
    result.core.close();
  });

  it('scheduled event with unknown job_type is ignored', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'scheduled',
        payload: { job_type: 'nonexistent_job' }
      }
    });

    assert.equal(result.context.current_block, 'lab_processing');
    assert.equal(result.result.transitioned, false);
    result.core.close();
  });

  it('conversation event during lab processing is handled without transition', async () => {
    // Customer asks "do I need to fast?" while waiting for lab results
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'conversation',
        payload: { text: 'Do I need to fast before my blood draw?' }
      }
    });

    assert.equal(result.context.current_block, 'lab_processing', 'should stay in block');
    assert.equal(result.result.transitioned, false);
    result.core.close();
  });

  it('duplicate results_ready webhooks — second one hits completed journey', async () => {
    // First webhook transitions to followup. If followup is the last block
    // and auto-completes the journey, a second webhook should be rejected.
    // But followup never auto-completes (checkCompletion returns false),
    // so the second webhook targets a journey that's now on "followup" block.
    const { results, core } = await teleportSequence({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      events: [
        // First: transitions lab_processing → followup
        {
          type: 'api',
          source: 'labcorp_webhook',
          payload: { labcorp_status: 'results_ready', lab_order_id: 'lab_dup_001' }
        },
        // Second: same webhook again — but we're now on followup block
        {
          type: 'api',
          source: 'labcorp_webhook',
          payload: { labcorp_status: 'results_ready', lab_order_id: 'lab_dup_001' }
        }
      ],
      contextOverrides: {
        'lab_processing.lab_order_id': 'lab_dup_001'
      }
    });

    // First should transition
    assert.equal(results[0].context.current_block, 'followup');

    // Second: followup block doesn't handle 'api' events with labcorp payloads
    // It should stay on followup and not crash
    assert.equal(results[1].context.current_block, 'followup');
    assert.equal(results[1].result.transitioned, false);
    core.close();
  });

  it('full multi-state walk: pending → awaiting → results_pending → results_ready', async () => {
    // Happy path through all internal states, one at a time
    const { results, core } = await teleportSequence({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      events: [
        { type: 'api', source: 'labcorp', payload: { labcorp_status: 'awaiting_lab_visit' } },
        { type: 'api', source: 'labcorp', payload: { labcorp_status: 'lab_results_pending' } },
        { type: 'api', source: 'labcorp', payload: { labcorp_status: 'results_ready' } }
      ],
      contextOverrides: {
        'lab_processing.lab_order_id': 'lab_walk_001',
        'block_state': 'lab_order_pending'
      }
    });

    // Step 1: pending → awaiting_lab_visit (internal, stays in block)
    assert.equal(results[0].context.current_block, 'lab_processing');
    assert.equal(results[0].context.block_state, 'awaiting_lab_visit');

    // Step 2: awaiting → lab_results_pending (internal, stays in block)
    assert.equal(results[1].context.current_block, 'lab_processing');
    assert.equal(results[1].context.block_state, 'lab_results_pending');

    // Step 3: results_pending → results_ready (exit state → transitions to followup)
    assert.equal(results[2].context.current_block, 'followup');
    assert.equal(results[2].result.transitioned, true);
    core.close();
  });
});
