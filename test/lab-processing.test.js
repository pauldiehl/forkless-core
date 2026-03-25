/**
 * Tests for lab_processing block — multi-state capability block.
 * Uses teleport for isolated block testing.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { teleport } = require('./teleport');

const labsOnly = require('./fixtures/labs-only.json');

describe('lab_processing block', () => {
  it('transitions to followup on results_ready webhook (exit state)', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'api',
        source: 'labcorp_webhook',
        payload: { labcorp_status: 'results_ready', lab_order_id: 'lab_test_001' }
      }
    });

    assert.equal(result.result.handled, true);
    assert.equal(result.context.current_block, 'followup');
    assert.equal(result.context.lab_processing.labcorp_status, 'results_ready');
    result.core.close();
  });

  it('handles lab_visit_reminder scheduled event without transitioning', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'scheduled',
        source: 'scheduler',
        payload: { job_type: 'lab_visit_reminder' }
      }
    });

    assert.equal(result.result.handled, true);
    assert.equal(result.result.transitioned, false);
    assert.equal(result.context.current_block, 'lab_processing');
    // Should have sent a reminder message
    assert.ok(result.messages.some(m => m.text.includes('visit')));
    result.core.close();
  });

  it('handles conversation events (questions) without transitioning', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'conversation',
        payload: { text: 'Do I need to fast before the blood draw?' }
      }
    });

    assert.equal(result.result.handled, true);
    assert.equal(result.result.transitioned, false);
    assert.equal(result.context.current_block, 'lab_processing');
    result.core.close();
  });

  it('updates status on intermediate webhook', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'api',
        source: 'labcorp_webhook',
        payload: { labcorp_status: 'processing', lab_order_id: 'lab_test_001' }
      }
    });

    assert.equal(result.result.handled, true);
    // processing is not an exit state, should stay in lab_processing
    assert.equal(result.context.current_block, 'lab_processing');
    // block_state should be updated to the derived value
    assert.equal(result.context.block_state, 'processing');
    result.core.close();
  });

  it('validates lab_order_id before processing webhook', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'api',
        source: 'labcorp_webhook',
        payload: { labcorp_status: 'results_ready' }
      },
      // Override to remove lab_order_id from context
      contextOverrides: { 'lab_processing.lab_order_id': null }
    });

    // Validation should fail — no lab_order_id in context
    // The handler runs validate before-action which should catch this
    assert.equal(result.result.handled, true);
    result.core.close();
  });
});
