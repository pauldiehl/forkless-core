/**
 * Seed — realistic journey state generator.
 *
 * Creates a journey instance with realistic context populated up to
 * a given block. Each block gets plausible data that would have been
 * collected during a real journey.
 *
 * Usage:
 *   const { seed } = require('./test/seed');
 *   const { core, ji, convo, user } = seed({
 *     journeyDef: labsOnlyDef,
 *     upToBlock: 'lab_processing',
 *     userData: { email: 'jane@example.com', name: 'Jane Smith' }
 *   });
 */

const { createCore } = require('../index');

/**
 * Default seed data for each block namespace.
 * Consumers can override any of these.
 */
const defaultSeedData = {
  presentation: {
    engaged: true,
    offering_slug: 'lab-panel'
  },
  simple_intake: {
    customerName: 'Jane Smith',
    customerEmail: 'jane@example.com',
    customerDob: '1990-05-15',
    customerGender: 'Female',
    state_of_residence: 'FL',
    healthConcerns: 'fatigue, weight gain'
  },
  recommendation: {
    offering: 'lab-panel',
    agreed: true,
    consent_recorded: true,
    panels: ['female_initial_panel']
  },
  payment: {
    order_id: 'sq_test_001',
    checkout_url: 'https://square.example/pay/sq_test_001',
    amount_cents: 14900,
    status: 'completed',
    completed_at: '2026-03-20T10:30:00Z'
  },
  lab_processing: {
    lab_order_id: 'lab_test_001',
    labcorp_status: 'pending',
    provider: 'labcorp',
    created_at: '2026-03-20T10:31:00Z'
  },
  followup: {
    scheduling_offered: false
  }
};

/**
 * Seed a journey instance up to a given block with realistic data.
 *
 * @param {Object} opts
 * @param {Object} opts.journeyDef - Journey definition (JSON object)
 * @param {string} [opts.upToBlock] - Block name to seed up to (inclusive). If omitted, seeds all blocks.
 * @param {Object} [opts.userData] - Override user data { email, name, phone }
 * @param {Object} [opts.overrides] - Override seed data per block namespace { simple_intake: { customerName: 'Paul' } }
 * @param {Object} [opts.coreOpts] - Options for createCore
 * @param {Object} [opts.core] - Existing core instance (won't create new one)
 * @returns {Object} { core, user, ji, convo, context }
 */
function seed(opts) {
  const { journeyDef, upToBlock, userData, overrides, coreOpts } = opts;
  const core = opts.core || createCore({ useMockLLM: true, ...coreOpts });

  // Register journey
  core.registerJourney(journeyDef);

  // Create user
  const user = core.db.users.create({
    email: userData?.email || 'seed-user@test.com',
    name: userData?.name || 'Seed User',
    phone: userData?.phone || null
  });

  // Determine which blocks to seed through
  const blockNames = journeyDef.blocks.map(b => b.block);
  const targetIdx = upToBlock
    ? blockNames.indexOf(upToBlock)
    : blockNames.length - 1;

  if (upToBlock && targetIdx === -1) {
    throw new Error(`Block "${upToBlock}" not found in journey "${journeyDef.journey_type}". Available: ${blockNames.join(', ')}`);
  }

  const currentBlock = blockNames[targetIdx];
  const completedBlocks = blockNames.slice(0, targetIdx);

  // Build context
  const now = new Date();
  const context = {
    journey_type: journeyDef.journey_type,
    current_block: currentBlock,
    block_state: null,
    journey_status: 'in_progress',
    conversation_summary: '',
    last_message_role: null,
    last_message_preview: null,
    user_id: user.id,
    conversation_id: null,
    campaign_id: null,
    started_at: new Date(now - 7 * 86400000).toISOString(),
    updated_at: now.toISOString(),
    block_history: []
  };

  // Populate completed blocks
  for (let i = 0; i <= targetIdx; i++) {
    const blockName = blockNames[i];
    const entered = new Date(now - (targetIdx - i + 1) * 3600000).toISOString();
    const exited = i < targetIdx
      ? new Date(now - (targetIdx - i) * 3600000).toISOString()
      : null;

    context.block_history.push({ block: blockName, entered, exited });

    // Seed block data
    const seedData = { ...(defaultSeedData[blockName] || {}) };
    if (overrides && overrides[blockName]) {
      Object.assign(seedData, overrides[blockName]);
    }
    if (Object.keys(seedData).length > 0) {
      context[blockName] = seedData;
    }
  }

  // Create journey instance
  const ji = core.db.journeyInstances.create({
    user_id: user.id,
    journey_type: journeyDef.journey_type,
    context,
    status: 'in_progress'
  });

  // Create conversation linked to journey
  const convo = core.db.conversations.create({
    user_id: user.id,
    journey_instance_id: ji.id
  });

  // Link conversation to context
  core.context.update(ji.id, { conversation_id: convo.id });

  const finalContext = core.context.read(ji.id);

  return { core, user, ji, convo, context: finalContext };
}

module.exports = { seed, defaultSeedData };
