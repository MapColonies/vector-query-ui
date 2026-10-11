#!/usr/bin/env node
/**
 * CLI over scripts/app-config.mjs.
 *
 *   node scripts/build-config.mjs --print            resolve and print, write nothing
 *   node scripts/build-config.mjs --html <file>      inject the result into a built page
 *
 * The container entrypoint uses the second form against the served index.html,
 * so the image picks up its environment at startup. Vite does the same thing
 * for `npm run dev` and `npm run build` — see vite.config.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, injectConfig, renderNginxProxy, resolveConfig } from './app-config.mjs';

function parseArgs(argv) {
  const args = { print: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--html') args.html = argv[++i];
    else if (a === '--nginx') args.nginx = argv[++i];
    else if (a === '--config-dir' || a === '-c') args.configDir = argv[++i];
    else if (a === '--print') args.print = true;
    else if (a === '--quiet' || a === '-q') args.quiet = true;
    else die(`unknown argument "${a}"`);
  }
  if (!args.html) args.print = true;
  return args;
}

function die(message) {
  console.error(`✗ config: ${message}`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config, proxy, sources, applied, nodeEnv } = resolveConfig({
    configDir: args.configDir ?? process.env.CONFIG_DIR,
  });

  if (args.print) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  writeFileSync(args.html, injectConfig(readFileSync(args.html, 'utf8'), config));

  if (args.nginx) {
    mkdirSync(args.nginx, { recursive: true });
    writeFileSync(join(args.nginx, 'proxy.conf'), renderNginxProxy(proxy));
  }

  if (!args.quiet) {
    console.log(`✓ config: injected into ${args.html} (NODE_ENV=${nodeEnv}, sources: ${sources.join(' → ')})`);
    if (applied.length > 0) console.log(`  environment overrides: ${applied.join(', ')}`);
    const prefixes = Object.keys(proxy);
    if (args.nginx && prefixes.length > 0) {
      console.log(`  proxying same-origin: ${prefixes.join(', ')}`);
    }
  }
}

try {
  main();
} catch (e) {
  if (e instanceof ConfigError) die(e.message);
  throw e;
}
