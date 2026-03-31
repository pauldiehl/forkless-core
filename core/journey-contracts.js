/**
 * Journey Contracts — Executable assertions derived from the journey spec.
 *
 * The journey definition already declares contracts:
 *   - reads/writes: what context paths a block depends on and produces
 *   - actor: who can drive this block
 *   - default_visibility: who sees the messages
 *   - checkCompletion: what must be true to advance
 *   - on_enter: what happens when you arrive
 *   - on_api_event: what external events trigger transitions
 *
 * But these are DOCUMENTATION, not ASSERTIONS. This module makes them executable.
 *
 * Three layers:
 *   1. Static analysis  (at journey registration / build time)
 *   2. Runtime guards    (at block entry / exit / transition)
 *   3. Scenario testing  (generate test cases from the spec)
 *
 * Design philosophy:
 *   - The journey JSON is the source of truth (SPEC-PRIME)
 *   - Contracts are DERIVED from what's already declared, not a second spec
 *   - Violations are warnings by default, errors in strict mode
 *   - Zero overhead in production unless enabled
 */

// ─── STATIC ANALYSIS ────────────────────────────────────────────────
// Run once at journey registration. Catches structural problems before
// any journey instance is created.

/**
 * Validate that the journey definition's block chain is internally consistent.
 * Returns { valid: boolean, warnings: string[], errors: string[] }
 */
function validateJourneyContracts(journeyDef, blockRegistry) {
  const warnings = [];
  const errors = [];
  const blocks = journeyDef.blocks || [];

  // Track what's been written by all blocks up to this point
  // (simulates the context accumulation as blocks execute in sequence)
  const availableWrites = new Set();

  for (let i = 0; i < blocks.length; i++) {
    const blockDef = blocks[i];
    const contract = blockRegistry[blockDef.block];

    if (!contract) {
      errors.push(`Block "${blockDef.block}" not found in block registry`);
      continue;
    }

    // ── 1. Reads/Writes chain validation ──
    // Every reads[] path should have been written by a prior block's writes[]
    const reads = contract.reads || [];
    for (const readPath of reads) {
      // Handle wildcard reads like 'simple_intake.*'
      const ns = readPath.split('.')[0];
      const isWildcard = readPath.endsWith('.*');

      if (isWildcard) {
        // Check if ANY prior block writes to this namespace
        const nsWritten = [...availableWrites].some(w => w.startsWith(ns + '.'));
        if (!nsWritten && i > 0) {
          warnings.push(
            `Block "${blockDef.block}" reads "${readPath}" but no prior block writes to "${ns}.*". ` +
            `Ensure a block before position ${i} writes to the "${ns}" namespace.`
          );
        }
      } else {
        // Exact path — check for exact or wildcard match
        const exactMatch = availableWrites.has(readPath);
        const wildcardMatch = availableWrites.has(ns + '.*');
        if (!exactMatch && !wildcardMatch && i > 0) {
          warnings.push(
            `Block "${blockDef.block}" reads "${readPath}" but no prior block declares it in writes[]. ` +
            `This dependency may be satisfied at runtime, but it's not declared.`
          );
        }
      }
    }

    // Add this block's writes to the available set
    const writes = contract.writes || [];
    for (const writePath of writes) {
      availableWrites.add(writePath);
    }

    // ── 2. Actor continuity ──
    // When actor changes between adjacent blocks, flag it (not an error,
    // but a handoff point that needs attention)
    if (i > 0) {
      const prevBlockDef = blocks[i - 1];
      const prevContract = blockRegistry[prevBlockDef.block];
      const prevActor = prevBlockDef.actor || prevContract?.actor || 'customer';
      const currActor = blockDef.actor || contract.actor || 'customer';

      if (prevActor !== currActor) {
        warnings.push(
          `Actor handoff at block ${i}: "${prevBlockDef.block}" (${prevActor}) → "${blockDef.block}" (${currActor}). ` +
          `Ensure the transition mechanism (webhook, manual advance, etc.) accounts for the actor change.`
        );
      }
    }

    // ── 3. Params schema validation ──
    // Check that journey-level params match the block's params_schema
    if (contract.params_schema && blockDef.params) {
      for (const [key, schema] of Object.entries(contract.params_schema)) {
        if (schema.required && (blockDef.params[key] === undefined || blockDef.params[key] === null)) {
          errors.push(
            `Block "${blockDef.block}" requires param "${key}" but journey definition doesn't provide it.`
          );
        }
        if (blockDef.params[key] !== undefined && schema.type) {
          const actualType = Array.isArray(blockDef.params[key]) ? 'array' : typeof blockDef.params[key];
          if (actualType !== schema.type) {
            errors.push(
              `Block "${blockDef.block}" param "${key}" should be ${schema.type} but got ${actualType}.`
            );
          }
        }
      }
    }

    // ── 4. on_enter capability dependency check ──
    // If on_enter calls a capability with params_from_context, verify those
    // context paths are in the available writes set
    if (contract.on_enter) {
      for (const action of contract.on_enter) {
        if (action.type === 'capability' && action.params_from_context) {
          for (const [param, ctxPath] of Object.entries(action.params_from_context)) {
            // Context path might be in this block's own namespace (set by params pre-population)
            const isOwnParam = ctxPath.startsWith(blockDef.block + '.');
            if (!isOwnParam && !availableWrites.has(ctxPath)) {
              const ns = ctxPath.split('.')[0];
              const wildcardMatch = availableWrites.has(ns + '.*');
              if (!wildcardMatch) {
                warnings.push(
                  `Block "${blockDef.block}" on_enter capability needs "${ctxPath}" (for param "${param}") ` +
                  `but no prior block declares this in writes[].`
                );
              }
            }
          }
        }
      }
    }

    // ── 5. skip_if path validation ──
    if (blockDef.skip_if) {
      const skipNs = blockDef.skip_if.split('.')[0];
      const nsWritten = [...availableWrites].some(w => w.startsWith(skipNs + '.'));
      if (!nsWritten) {
        warnings.push(
          `Block "${blockDef.block}" has skip_if="${blockDef.skip_if}" but no prior block ` +
          `writes to the "${skipNs}" namespace. The skip condition may never be true.`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
    summary: `${blocks.length} blocks, ${errors.length} errors, ${warnings.length} warnings`
  };
}


// ─── RUNTIME GUARDS ─────────────────────────────────────────────────
// Called at block entry/exit during journey execution.
// Returns violation details; the caller decides whether to warn or throw.

/**
 * Check that a block's declared reads[] are satisfied in the current context.
 * Call this at block entry (before on_enter or first event).
 *
 * @param {Object} blockDef - Journey-level block definition
 * @param {Object} contract - Block contract from registry
 * @param {Object} context - Current journey context
 * @returns {{ satisfied: boolean, missing: string[], available: string[] }}
 */
function checkReadsContract(blockDef, contract, context) {
  const reads = contract.reads || [];
  const missing = [];
  const available = [];

  for (const readPath of reads) {
    const isWildcard = readPath.endsWith('.*');
    const ns = readPath.split('.')[0];

    if (isWildcard) {
      // Check if namespace exists and has at least one key
      if (context[ns] && typeof context[ns] === 'object' && Object.keys(context[ns]).length > 0) {
        available.push(readPath);
      } else {
        missing.push(readPath);
      }
    } else {
      // Check exact path
      const value = resolvePath(context, readPath);
      if (value !== undefined && value !== null && value !== '') {
        available.push(readPath);
      } else {
        missing.push(readPath);
      }
    }
  }

  return {
    satisfied: missing.length === 0,
    missing,
    available,
    block: blockDef.block
  };
}

/**
 * Check that a block's declared writes[] were actually written before exit.
 * Call this at block transition (after completion, before on_enter of next block).
 *
 * @param {Object} blockDef - Journey-level block definition
 * @param {Object} contract - Block contract from registry
 * @param {Object} context - Current journey context (post-execution)
 * @returns {{ fulfilled: boolean, missing: string[], written: string[] }}
 */
function checkWritesContract(blockDef, contract, context) {
  const writes = contract.writes || [];
  const missing = [];
  const written = [];

  for (const writePath of writes) {
    const isWildcard = writePath.endsWith('.*');
    const ns = writePath.split('.')[0];

    if (isWildcard) {
      if (context[ns] && typeof context[ns] === 'object' && Object.keys(context[ns]).length > 0) {
        written.push(writePath);
      } else {
        missing.push(writePath);
      }
    } else {
      const value = resolvePath(context, writePath);
      if (value !== undefined && value !== null) {
        written.push(writePath);
      } else {
        missing.push(writePath);
      }
    }
  }

  return {
    fulfilled: missing.length === 0,
    missing,
    written,
    block: blockDef.block
  };
}

/**
 * Validate a transition point: exiting block's writes fulfilled AND
 * entering block's reads satisfied.
 *
 * @param {Object} exitBlockDef - Block being exited
 * @param {Object} exitContract - Exit block's contract
 * @param {Object} enterBlockDef - Block being entered
 * @param {Object} enterContract - Enter block's contract
 * @param {Object} context - Current context at transition
 * @returns {{ valid: boolean, exitCheck: Object, enterCheck: Object }}
 */
function checkTransitionContract(exitBlockDef, exitContract, enterBlockDef, enterContract, context) {
  const exitCheck = checkWritesContract(exitBlockDef, exitContract, context);
  const enterCheck = checkReadsContract(enterBlockDef, enterContract, context);

  return {
    valid: exitCheck.fulfilled && enterCheck.satisfied,
    exitCheck,
    enterCheck,
    transition: `${exitBlockDef.block} → ${enterBlockDef.block}`
  };
}


// ─── SCENARIO GENERATION ────────────────────────────────────────────
// Generate test scenarios from the journey spec.
// These describe WHAT to test, not HOW — the test runner fills in the details.

/**
 * Generate a set of contract-derived test scenarios for a journey.
 * Each scenario is a plain object describing what to assert.
 *
 * @param {Object} journeyDef - Journey definition
 * @param {Object} blockRegistry - Block registry
 * @returns {Array<Object>} Test scenario descriptors
 */
function generateScenarios(journeyDef, blockRegistry) {
  const scenarios = [];
  const blocks = journeyDef.blocks || [];

  // ── Happy path: full journey traversal ──
  scenarios.push({
    type: 'happy_path',
    name: `${journeyDef.journey_type}: full journey completes`,
    description: 'All blocks execute in sequence, all reads/writes satisfied, journey reaches completed status.',
    blocks: blocks.map(b => b.block),
    assertions: [
      { type: 'journey_status', expected: 'completed' },
      { type: 'all_blocks_visited', blocks: blocks.filter(b => !b.skip_if).map(b => b.block) }
    ]
  });

  // ── Per-block entry contracts ──
  for (let i = 0; i < blocks.length; i++) {
    const blockDef = blocks[i];
    const contract = blockRegistry[blockDef.block];
    if (!contract) continue;

    // Entry reads check
    if (contract.reads && contract.reads.length > 0) {
      scenarios.push({
        type: 'block_entry',
        name: `${blockDef.block}: reads satisfied on entry`,
        description: `When entering "${blockDef.block}", all declared reads[] paths must exist in context.`,
        block: blockDef.block,
        position: i,
        reads: contract.reads,
        assertions: [
          { type: 'reads_satisfied', block: blockDef.block, paths: contract.reads }
        ]
      });
    }

    // Exit writes check
    if (contract.writes && contract.writes.length > 0) {
      scenarios.push({
        type: 'block_exit',
        name: `${blockDef.block}: writes fulfilled on exit`,
        description: `When exiting "${blockDef.block}", all declared writes[] paths must be set in context.`,
        block: blockDef.block,
        position: i,
        writes: contract.writes,
        assertions: [
          { type: 'writes_fulfilled', block: blockDef.block, paths: contract.writes }
        ]
      });
    }
  }

  // ── Actor handoff scenarios ──
  for (let i = 1; i < blocks.length; i++) {
    const prevDef = blocks[i - 1];
    const currDef = blocks[i];
    const prevContract = blockRegistry[prevDef.block];
    const currContract = blockRegistry[currDef.block];
    if (!prevContract || !currContract) continue;

    const prevActor = prevDef.actor || prevContract.actor || 'customer';
    const currActor = currDef.actor || currContract.actor || 'customer';

    if (prevActor !== currActor) {
      scenarios.push({
        type: 'actor_handoff',
        name: `${prevDef.block} → ${currDef.block}: actor handoff (${prevActor} → ${currActor})`,
        description: `Transition changes actor from ${prevActor} to ${currActor}. ` +
          `The new actor must be able to interact with the block. ` +
          `The previous actor should enter observation mode (not be blocked).`,
        from: { block: prevDef.block, actor: prevActor },
        to: { block: currDef.block, actor: currActor },
        assertions: [
          { type: 'correct_actor_can_drive', block: currDef.block, actor: currActor },
          { type: 'wrong_actor_observes', block: currDef.block, actor: prevActor, expectObservationMode: true }
        ]
      });
    }
  }

  // ── Skip-if scenarios ──
  for (const blockDef of blocks) {
    if (blockDef.skip_if) {
      scenarios.push({
        type: 'skip_condition',
        name: `${blockDef.block}: skipped when ${blockDef.skip_if} is truthy`,
        description: `Block "${blockDef.block}" should be skipped when context path "${blockDef.skip_if}" is truthy.`,
        block: blockDef.block,
        skip_if: blockDef.skip_if,
        assertions: [
          { type: 'block_skipped_when', condition: blockDef.skip_if, value: true },
          { type: 'block_entered_when', condition: blockDef.skip_if, value: false }
        ]
      });
    }
  }

  // ── Webhook handler scenarios ──
  for (const blockDef of blocks) {
    const contract = blockRegistry[blockDef.block];
    if (!contract?.on_api_event) continue;

    for (const [handlerName, handler] of Object.entries(contract.on_api_event)) {
      scenarios.push({
        type: 'webhook_handler',
        name: `${blockDef.block}: ${handlerName} webhook handler`,
        description: `API event "${handlerName}" on block "${blockDef.block}" should ${handler.transition ? 'transition to next block' : 'stay on current block'}.`,
        block: blockDef.block,
        handler: handlerName,
        expects_transition: !!handler.transition,
        has_validation: (handler.before || []).some(a => a.type === 'validate'),
        assertions: [
          { type: 'handler_found', block: blockDef.block, handler: handlerName },
          handler.transition
            ? { type: 'transitions_on_event', block: blockDef.block, handler: handlerName }
            : { type: 'stays_on_block', block: blockDef.block, handler: handlerName }
        ]
      });
    }
  }

  // ── Visibility isolation scenarios ──
  for (const blockDef of blocks) {
    const contract = blockRegistry[blockDef.block];
    if (!contract) continue;

    const visibility = blockDef.default_visibility || contract.default_visibility;
    if (visibility && !visibility.includes('all')) {
      const excludedActors = ['customer', 'physician', 'agent', 'admin']
        .filter(a => !visibility.includes(a));

      if (excludedActors.length > 0) {
        scenarios.push({
          type: 'visibility_isolation',
          name: `${blockDef.block}: messages hidden from ${excludedActors.join(', ')}`,
          description: `Block "${blockDef.block}" has visibility [${visibility.join(', ')}]. ` +
            `Messages should NOT be visible to: ${excludedActors.join(', ')}.`,
          block: blockDef.block,
          visibility,
          excluded: excludedActors,
          assertions: excludedActors.map(actor => ({
            type: 'actor_cannot_see', block: blockDef.block, actor
          }))
        });
      }
    }
  }

  return scenarios;
}


// ─── HELPERS ────────────────────────────────────────────────────────

function resolvePath(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}


module.exports = {
  validateJourneyContracts,
  checkReadsContract,
  checkWritesContract,
  checkTransitionContract,
  generateScenarios
};
