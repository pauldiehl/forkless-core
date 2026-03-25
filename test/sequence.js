/**
 * Sequence — markdown sequence log generator.
 *
 * Replays a scripted event sequence through the event router and generates
 * a markdown log showing every event, state change, action, and context delta.
 *
 * Usage:
 *   const { runSequence, formatMarkdown } = require('./test/sequence');
 *   const log = await runSequence({
 *     journeyDef,
 *     script: [
 *       { actor: 'CUSTOMER', text: 'I have been so tired' },
 *       { actor: 'CUSTOMER', text: 'Jane Smith' },
 *       { actor: 'WEBHOOK', source: 'square', payload: { status: 'completed' } }
 *     ]
 *   });
 *   const md = formatMarkdown(log);
 *   fs.writeFileSync('sequence.md', md);
 */

const { seed } = require('./seed');
const { registerMockCapabilities } = require('./fixtures/mock-capabilities');

/**
 * Run a scripted sequence and collect detailed logs.
 *
 * @param {Object} opts
 * @param {Object} opts.journeyDef - Journey definition
 * @param {Array} opts.script - Ordered event descriptions
 * @param {Object} [opts.userData] - Override user data
 * @param {Object} [opts.seedOverrides] - Override seed data
 * @param {string} [opts.startAtBlock] - Block to start at (defaults to first block)
 * @returns {Object} { entries[], journeyDef, finalContext }
 */
async function runSequence(opts) {
  const { journeyDef, script, userData, seedOverrides, startAtBlock } = opts;

  const startBlock = startAtBlock || journeyDef.blocks[0].block;

  const seeded = seed({
    journeyDef,
    upToBlock: startBlock,
    userData,
    overrides: seedOverrides
  });

  const { core, ji, convo, user } = seeded;
  registerMockCapabilities(core.capabilityRegistry);

  const entries = [];

  for (let i = 0; i < script.length; i++) {
    const step = script[i];
    const beforeCtx = JSON.parse(JSON.stringify(core.context.read(ji.id)));

    // Build the event from the script step
    const event = buildEvent(step, ji.id);

    let result;
    try {
      result = await core.eventRouter.handleEvent(event);
    } catch (err) {
      entries.push({
        index: i + 1,
        actor: step.actor || 'UNKNOWN',
        event,
        error: err.message,
        beforeBlock: beforeCtx.current_block,
        beforeState: beforeCtx.block_state
      });
      continue;
    }

    const afterCtx = core.context.read(ji.id);
    const messages = core.db.conversations.get(convo.id).messages;
    const newMessages = messages.slice(
      entries.reduce((sum, e) => sum + (e.newMessages?.length || 0), 0)
    );

    // Compute context delta
    const delta = computeDelta(beforeCtx, afterCtx);

    entries.push({
      index: i + 1,
      actor: step.actor || 'UNKNOWN',
      input: step.text || JSON.stringify(step.payload || {}),
      event,
      result,
      beforeBlock: beforeCtx.current_block,
      beforeState: beforeCtx.block_state,
      afterBlock: afterCtx.current_block,
      afterState: afterCtx.block_state,
      transitioned: result.transitioned,
      journeyStatus: afterCtx.journey_status,
      newMessages,
      delta,
      actions: result.actions || []
    });
  }

  const finalContext = core.context.read(ji.id);
  core.close();

  return { entries, journeyDef, finalContext, user };
}

/**
 * Format a sequence log as markdown.
 */
function formatMarkdown(log) {
  const lines = [];
  lines.push(`# Sequence Log: ${log.journeyDef.journey_type}`);
  lines.push('');
  lines.push(`> Blocks: ${log.journeyDef.blocks.map(b => b.block).join(' → ')}`);
  lines.push(`> User: ${log.user?.name || 'unknown'} (${log.user?.email || 'unknown'})`);
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  let currentBlock = null;

  for (const entry of log.entries) {
    // Block header when block changes
    if (entry.beforeBlock !== currentBlock) {
      currentBlock = entry.beforeBlock;
      lines.push(`### BLOCK: ${currentBlock}`);
      lines.push('');
    }

    lines.push('```');
    lines.push(`${String(entry.index).padStart(3, '0')}  [${entry.actor}]${entry.actor === 'CUSTOMER' ? `  "${entry.input}"` : `  ${entry.event.type}: ${entry.event.source || entry.input}`}`);

    if (entry.error) {
      lines.push(`     ERROR:     ${entry.error}`);
    } else {
      // State change
      if (entry.transitioned) {
        lines.push(`     STATE:     ${entry.beforeBlock}${entry.beforeState ? '/' + entry.beforeState : ''} → ${entry.afterBlock}${entry.afterState ? '/' + entry.afterState : ''}`);
      } else {
        lines.push(`     STATE:     ${entry.afterBlock}${entry.afterState ? '/' + entry.afterState : ''} (no change)`);
      }

      // Actions / messages
      if (entry.newMessages && entry.newMessages.length > 0) {
        lines.push(`     ACTIONS:`);
        for (const msg of entry.newMessages) {
          const preview = msg.text.length > 80 ? msg.text.slice(0, 77) + '...' : msg.text;
          lines.push(`       ${msg.role} → "${preview}"`);
        }
      }

      // Context delta
      if (entry.delta && Object.keys(entry.delta).length > 0) {
        const deltaKeys = Object.keys(entry.delta).filter(k => !['updated_at', 'block_history'].includes(k));
        if (deltaKeys.length > 0) {
          lines.push(`     CONTEXT:   ${deltaKeys.map(k => `${k}: ${JSON.stringify(entry.delta[k])}`).join(', ')}`);
        }
      }

      if (entry.journeyStatus === 'completed') {
        lines.push(`     → JOURNEY COMPLETE`);
      }
    }

    lines.push('```');
    lines.push('');

    // Block transition header
    if (entry.transitioned && entry.afterBlock !== currentBlock) {
      currentBlock = entry.afterBlock;
      lines.push(`### BLOCK: ${currentBlock}`);
      lines.push('');
    }
  }

  // Final state summary
  lines.push('---');
  lines.push('');
  lines.push('### Final Context');
  lines.push('');
  lines.push('```json');
  const ctx = { ...log.finalContext };
  delete ctx.block_history; // too verbose for summary
  lines.push(JSON.stringify(ctx, null, 2));
  lines.push('```');

  return lines.join('\n');
}

/**
 * Build an event object from a script step.
 */
function buildEvent(step, journeyId) {
  const actor = (step.actor || '').toUpperCase();

  if (actor === 'CUSTOMER' || step.text) {
    return {
      type: 'conversation',
      journey_id: journeyId,
      source: 'customer',
      payload: { text: step.text },
      timestamp: step.timestamp || new Date().toISOString()
    };
  }

  if (actor === 'WEBHOOK' || step.type === 'api') {
    return {
      type: 'api',
      journey_id: journeyId,
      source: step.source || 'webhook',
      payload: step.payload || {},
      timestamp: step.timestamp || new Date().toISOString()
    };
  }

  if (actor === 'SYSTEM' || step.type === 'system') {
    return {
      type: 'system',
      journey_id: journeyId,
      source: step.source || 'system',
      payload: step.payload || {},
      timestamp: step.timestamp || new Date().toISOString()
    };
  }

  if (actor === 'SCHEDULER' || step.type === 'scheduled') {
    return {
      type: 'scheduled',
      journey_id: journeyId,
      source: 'scheduler',
      payload: step.payload || {},
      timestamp: step.timestamp || new Date().toISOString()
    };
  }

  // Default to conversation
  return {
    type: step.type || 'conversation',
    journey_id: journeyId,
    source: step.source || 'unknown',
    payload: step.payload || { text: step.text || '' },
    timestamp: step.timestamp || new Date().toISOString()
  };
}

/**
 * Compute changed keys between two context snapshots.
 */
function computeDelta(before, after) {
  const delta = {};
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const bVal = JSON.stringify(before[key]);
    const aVal = JSON.stringify(after[key]);
    if (bVal !== aVal) {
      delta[key] = after[key];
    }
  }

  return delta;
}

module.exports = { runSequence, formatMarkdown, buildEvent, computeDelta };
