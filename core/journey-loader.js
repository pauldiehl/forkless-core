/**
 * Journey Loader — reads journey JSON definitions and validates block references.
 *
 * Journey definitions are JSON objects describing an ordered sequence of
 * parameterized blocks. The loader validates that each referenced block
 * is registered in the block registry.
 */

const fs = require('fs');
const path = require('path');

/**
 * Load a journey definition from a JSON file or object.
 * Validates that all referenced blocks exist in the block registry.
 *
 * @param {Object|string} source - Journey definition object or path to JSON file
 * @param {Object} blockRegistry - Map of block name → block contract
 * @returns {Object} Validated journey definition
 */
function loadJourney(source, blockRegistry) {
  let definition;

  if (typeof source === 'string') {
    const raw = fs.readFileSync(source, 'utf8');
    definition = JSON.parse(raw);
  } else {
    definition = source;
  }

  validate(definition, blockRegistry);
  return definition;
}

/**
 * Load all journey definitions from a directory.
 *
 * @param {string} dir - Directory containing journey JSON files
 * @param {Object} blockRegistry - Map of block name → block contract
 * @returns {Object} Map of journey_type → definition
 */
function loadJourneysFromDir(dir, blockRegistry) {
  const definitions = {};
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const def = loadJourney(fullPath, blockRegistry);
    definitions[def.journey_type] = def;
  }

  return definitions;
}

/**
 * Validate a journey definition.
 */
function validate(definition, blockRegistry) {
  if (!definition.journey_type) {
    throw new Error('Journey definition must have a journey_type');
  }
  if (!Array.isArray(definition.blocks) || definition.blocks.length === 0) {
    throw new Error(`Journey "${definition.journey_type}" must have at least one block`);
  }

  const errors = [];
  for (const entry of definition.blocks) {
    if (!entry.block) {
      errors.push('Block entry missing "block" field');
      continue;
    }
    if (blockRegistry && !blockRegistry[entry.block]) {
      errors.push(`Block "${entry.block}" is not registered`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Journey "${definition.journey_type}" validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

/**
 * Build a block registry (name → contract) from block modules.
 */
function buildBlockRegistry(blocks) {
  const registry = {};
  for (const block of blocks) {
    if (!block.name) throw new Error('Block contract must have a name');
    registry[block.name] = block;
  }
  return registry;
}

module.exports = { loadJourney, loadJourneysFromDir, validate, buildBlockRegistry };
