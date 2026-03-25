#!/usr/bin/env node

/**
 * Forkless test CLI.
 *
 * Usage:
 *   npx forkless-test seed --journey test/fixtures/labs-only.json --up-to-block payment
 *   npx forkless-test teleport --journey test/fixtures/labs-only.json --at-block lab_processing --event '{"type":"api","payload":{"labcorp_status":"results_ready"}}'
 *   npx forkless-test sequence --journey test/fixtures/labs-only.json --script test/fixtures/labs-script.json --output ./test/output/
 */

const path = require('path');
const fs = require('fs');

const command = process.argv[2];

if (!command || command === 'help' || command === '--help') {
  printHelp();
  process.exit(0);
}

function printHelp() {
  console.log(`
forkless-test — testing tools for @forkless/core

Commands:

  seed       Seed a journey instance with realistic data up to a given block.
             --journey <path>   Journey definition JSON file
             --up-to-block <name>  Block to seed up to (default: all)
             --user-email <email>  Override user email
             --user-name <name>    Override user name

  teleport   Seed to a block and fire a single event.
             --journey <path>   Journey definition JSON file
             --at-block <name>  Block to teleport to
             --event <json>     Event JSON to fire

  sequence   Run a scripted event sequence and generate a markdown log.
             --journey <path>   Journey definition JSON file
             --script <path>    Script JSON file (array of event steps)
             --output <dir>     Output directory (default: stdout)
             --start-at <name>  Block to start at (default: first block)

Examples:

  npx forkless-test seed --journey test/fixtures/labs-only.json --up-to-block payment
  npx forkless-test teleport --journey test/fixtures/labs-only.json --at-block lab_processing --event '{"type":"api","payload":{"labcorp_status":"results_ready"}}'
  npx forkless-test sequence --journey test/fixtures/labs-only.json --script test/fixtures/labs-script.json
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 3; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1];
      args[key] = val;
      i++;
    }
  }
  return args;
}

function loadJSON(filePath) {
  const resolved = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv);

  switch (command) {
    case 'seed': {
      const { seed } = require('./seed');
      if (!args.journey) { console.error('--journey required'); process.exit(1); }
      const journeyDef = loadJSON(args.journey);

      const result = seed({
        journeyDef,
        upToBlock: args['up-to-block'],
        userData: {
          email: args['user-email'] || 'seed-user@test.com',
          name: args['user-name'] || 'Seed User'
        }
      });

      console.log('Seeded journey instance:');
      console.log(`  User: ${result.user.name} (${result.user.email})`);
      console.log(`  Journey: ${result.ji.id}`);
      console.log(`  Block: ${result.context.current_block}`);
      console.log(`  Status: ${result.context.journey_status}`);
      console.log('');
      console.log('Context:');
      console.log(JSON.stringify(result.context, null, 2));

      result.core.close();
      break;
    }

    case 'teleport': {
      const { teleport } = require('./teleport');
      if (!args.journey) { console.error('--journey required'); process.exit(1); }
      if (!args['at-block']) { console.error('--at-block required'); process.exit(1); }
      if (!args.event) { console.error('--event required'); process.exit(1); }

      const journeyDef = loadJSON(args.journey);
      const event = JSON.parse(args.event);

      const result = await teleport({
        journeyDef,
        atBlock: args['at-block'],
        event
      });

      console.log('Teleport result:');
      console.log(`  Before: ${result.beforeContext.current_block}`);
      console.log(`  After: ${result.context.current_block}`);
      console.log(`  Transitioned: ${result.result.transitioned}`);
      console.log(`  Journey status: ${result.context.journey_status}`);
      console.log('');

      if (result.messages.length > 0) {
        console.log('Messages:');
        for (const m of result.messages) {
          console.log(`  [${m.role}] ${m.text}`);
        }
      }

      result.core.close();
      break;
    }

    case 'sequence': {
      const { runSequence, formatMarkdown } = require('./sequence');
      if (!args.journey) { console.error('--journey required'); process.exit(1); }
      if (!args.script) { console.error('--script required'); process.exit(1); }

      const journeyDef = loadJSON(args.journey);
      const script = loadJSON(args.script);

      const log = await runSequence({
        journeyDef,
        script,
        startAtBlock: args['start-at']
      });

      const md = formatMarkdown(log);

      if (args.output) {
        const dir = path.resolve(args.output);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const outPath = path.join(dir, `sequence-${journeyDef.journey_type}.md`);
        fs.writeFileSync(outPath, md);
        console.log(`Sequence log written to: ${outPath}`);
      } else {
        console.log(md);
      }

      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
