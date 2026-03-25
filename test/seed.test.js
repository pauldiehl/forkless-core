const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { seed, defaultSeedData } = require('./seed');

const labsOnly = require('./fixtures/labs-only.json');

describe('seed', () => {
  it('seeds to first block with minimal context', () => {
    const result = seed({ journeyDef: labsOnly, upToBlock: 'presentation' });
    assert.equal(result.context.current_block, 'presentation');
    assert.equal(result.context.journey_status, 'in_progress');
    assert.ok(result.context.presentation.engaged);
    assert.equal(result.context.block_history.length, 1);
    assert.equal(result.context.block_history[0].block, 'presentation');
    assert.equal(result.context.block_history[0].exited, null); // current block
    result.core.close();
  });

  it('seeds to middle block with completed blocks populated', () => {
    const result = seed({ journeyDef: labsOnly, upToBlock: 'payment' });
    assert.equal(result.context.current_block, 'payment');
    // Prior blocks should have seed data
    assert.equal(result.context.presentation.engaged, true);
    assert.equal(result.context.simple_intake.customerName, 'Jane Smith');
    assert.equal(result.context.simple_intake.customerEmail, 'jane@example.com');
    // Block history should show all blocks up to payment
    assert.equal(result.context.block_history.length, 3); // presentation, simple_intake, payment
    // Prior blocks should be exited
    assert.ok(result.context.block_history[0].exited);
    assert.ok(result.context.block_history[1].exited);
    assert.equal(result.context.block_history[2].exited, null); // current
    result.core.close();
  });

  it('seeds to lab_processing with all prior data', () => {
    const result = seed({ journeyDef: labsOnly, upToBlock: 'lab_processing' });
    assert.equal(result.context.current_block, 'lab_processing');
    assert.equal(result.context.payment.status, 'completed');
    assert.equal(result.context.lab_processing.lab_order_id, 'lab_test_001');
    result.core.close();
  });

  it('seeds all blocks when upToBlock is omitted', () => {
    const result = seed({ journeyDef: labsOnly });
    assert.equal(result.context.current_block, 'followup');
    assert.equal(result.context.block_history.length, 5);
    result.core.close();
  });

  it('overrides seed data per block', () => {
    const result = seed({
      journeyDef: labsOnly,
      upToBlock: 'simple_intake',
      overrides: {
        simple_intake: { customerName: 'Paul', customerEmail: 'paul@test.com' }
      }
    });
    assert.equal(result.context.simple_intake.customerName, 'Paul');
    assert.equal(result.context.simple_intake.customerEmail, 'paul@test.com');
    // Other default fields should still be present
    assert.equal(result.context.simple_intake.customerGender, 'Female');
    result.core.close();
  });

  it('overrides user data', () => {
    const result = seed({
      journeyDef: labsOnly,
      upToBlock: 'presentation',
      userData: { email: 'custom@test.com', name: 'Custom User' }
    });
    assert.equal(result.user.email, 'custom@test.com');
    assert.equal(result.user.name, 'Custom User');
    result.core.close();
  });

  it('links conversation to journey instance', () => {
    const result = seed({ journeyDef: labsOnly, upToBlock: 'presentation' });
    assert.ok(result.convo.id);
    assert.equal(result.convo.journey_instance_id, result.ji.id);
    assert.equal(result.context.conversation_id, result.convo.id);
    result.core.close();
  });

  it('throws for unknown block', () => {
    assert.throws(
      () => seed({ journeyDef: labsOnly, upToBlock: 'nonexistent' }),
      /not found in journey/
    );
  });
});
