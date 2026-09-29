#!/usr/bin/env node
/**
 * Release gate: prove this plugin's '@deepseek-ai/dsh*' peer ranges admit every
 * runtime we intend to support.
 *
 * DSH refuses to load a plugin whose dsh peer range does not admit the running
 * harness, and it checks the RANGE, never the API. A range that is too wide
 * therefore keeps working right up until an API disappears underneath it, and a
 * range that is too narrow turns a harmless upgrade into a refused start. This
 * script runs the evaluator DSH itself ships (from @deepseek-ai/dsh-app-boot)
 * instead of restating its semver rules here, so the gate cannot drift from the
 * thing that actually runs at load time.
 *
 * Usage
 *   node scripts/check-compat.mjs
 *   node scripts/check-compat.mjs --runtime 0.2.0 --runtime 0.2.5
 *   node scripts/check-compat.mjs --plugin packages/browser/bridge-browser
 *   node scripts/check-compat.mjs --dsh /path/to/dsh
 *
 * Exits 1 when any range rejects any runtime, 2 when the check itself cannot run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HELP = [
  'Usage: node scripts/check-compat.mjs [options]',
  '',
  '  --plugin <dir>      plugin package directory (repeatable; default: .)',
  '  --runtime <semver>  runtime to test (repeatable; default: the installed dsh)',
  '  --dsh <dir>         DSH installation root, when dsh is not on PATH',
  '  --json              machine-readable output',
  '  -h, --help          this help',
].join('\n');

const REMEDY = [
  'Widen the upper bound to the next minor, keeping the prerelease floor:',
  "  '>=0.1.0-rc.6 <0.3.0-0'  ->  '>=0.1.0-rc.6 <0.4.0-0'",
  'The trailing -0 matters: without it 0.4.0-rc.1 (the riskiest prerelease) slips in.',
  'Widen, re-run this check against the new runtime, then republish.',
  'To unblock one machine without republishing, grant an exact-version exemption:',
  '  dsh plugin --profile <name> allow-version <plugin-name>@<version>',
].join('\n');

function parseArgs(argv) {
  const plugins = [];
  const runtimes = [];
  let dsh;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plugin') plugins.push(argv[i += 1]);
    else if (arg === '--runtime') runtimes.push(argv[i += 1]);
    else if (arg === '--dsh') dsh = argv[i += 1];
    else if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    } else {
      console.error('unknown argument: ' + arg + '\n\n' + HELP);
      process.exit(2);
    }
  }
  return { plugins: plugins.length > 0 ? plugins : ['.'], runtimes, dsh, json };
}

/**
 * Places to resolve '@deepseek-ai/dsh-app-boot' from, most explicit first.
 * Resolving from a real file (rather than guessing a root directory) keeps the
 * pnpm, npm-global and app-bundle layouts all working.
 */
function resolutionAnchors(explicitRoot) {
  const anchors = [];
  if (explicitRoot) anchors.push(join(resolve(explicitRoot), 'package.json'));
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    if (bin) {
      const real = realpathSync(bin);
      anchors.push(statSync(real).isDirectory() ? join(real, 'package.json') : real);
    }
  } catch {
    // no dsh on PATH; the remaining anchors still apply
  }
  anchors.push(join(process.cwd(), 'package.json'));
  return anchors;
}

function appBootFrom(anchor) {
  try {
    const appBoot = createRequire(anchor).resolve('@deepseek-ai/dsh-app-boot/package.json');
    const entry = join(dirname(appBoot), 'lib', 'index.js');
    return existsSync(entry) ? { entry, appBoot } : undefined;
  } catch {
    return undefined;
  }
}

function resolveEvaluator(explicitRoot) {
  for (const anchor of resolutionAnchors(explicitRoot)) {
    const direct = appBootFrom(anchor);
    if (direct) return direct;
    // pnpm keeps a package's dependencies beside it rather than at the workspace
    // root, so resolve the harness package first and ask again from inside it.
    try {
      const dshPackage = createRequire(anchor).resolve('@deepseek-ai/dsh/package.json');
      const nested = appBootFrom(dshPackage);
      if (nested) return nested;
    } catch {
      // try the next anchor
    }
  }
  return undefined;
}

async function loadEvaluator(entry) {
  let mod;
  try {
    mod = createRequire(import.meta.url)(entry);
  } catch {
    mod = await import(pathToFileURL(entry).href);
  }
  const evaluate = mod.evaluatePluginCompatibility || (mod.default && mod.default.evaluatePluginCompatibility);
  if (typeof evaluate !== 'function') {
    throw new Error('no evaluatePluginCompatibility export in ' + entry);
  }
  return {
    evaluate,
    runtimeVersion: typeof mod.getDshRuntimeVersion === 'function' ? mod.getDshRuntimeVersion() : undefined,
  };
}

/** Names the DSH compatibility check actually evaluates. */
function dshPeers(manifest) {
  return Object.keys(manifest.peerDependencies || {}).filter(
    (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
  );
}

function width(values) {
  return Math.max(...values.map((value) => String(value).length));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolved = resolveEvaluator(options.dsh);
  if (!resolved) {
    console.error('cannot find a DSH installation: @deepseek-ai/dsh-app-boot is not resolvable');
    console.error('(put dsh on PATH, or pass --dsh <dsh installation root>)');
    process.exit(2);
  }

  let evaluator;
  try {
    evaluator = await loadEvaluator(resolved.entry);
  } catch (error) {
    console.error('cannot load the DSH compatibility evaluator: ' + error.message);
    process.exit(2);
  }

  const runtimes = options.runtimes.length > 0 ? options.runtimes : [evaluator.runtimeVersion];
  if (!runtimes[0]) {
    console.error('cannot determine the installed runtime version; pass --runtime <semver>');
    process.exit(2);
  }

  const rows = [];
  let failed = false;
  for (const dir of options.plugins) {
    const manifestPath = resolve(dir, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      console.error('cannot read ' + manifestPath + ': ' + error.message);
      process.exit(2);
    }

    const id = (manifest.name || manifestPath) + '@' + (manifest.version || '?');
    if (dshPeers(manifest).length === 0) {
      for (const runtime of runtimes) {
        rows.push({ plugin: id, runtime: String(runtime), ok: true, checked: false, peers: {} });
      }
      continue;
    }

    for (const runtime of runtimes) {
      let issue;
      try {
        issue = evaluator.evaluate(manifest, {}, runtime);
      } catch (error) {
        console.error(id + ' against ' + runtime + ': ' + error.message);
        failed = true;
        continue;
      }
      rows.push({ plugin: id, runtime: String(runtime), ok: !issue, checked: true, peers: issue ? issue.peers : {} });
      if (issue) failed = true;
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ evaluator: resolved.appBoot, runtimeVersion: evaluator.runtimeVersion, failed, rows }, null, 2));
    process.exit(failed ? 1 : 0);
  }

  const pluginWidth = width(['plugin'].concat(rows.map((row) => row.plugin)));
  const runtimeWidth = width(['runtime'].concat(rows.map((row) => row.runtime)));
  console.log('plugin'.padEnd(pluginWidth) + '  ' + 'runtime'.padEnd(runtimeWidth) + '  result');
  for (const row of rows) {
    const result = row.checked === false ? 'no dsh peers' : row.ok ? 'ok' : 'INCOMPATIBLE';
    console.log(row.plugin.padEnd(pluginWidth) + '  ' + row.runtime.padEnd(runtimeWidth) + '  ' + result);
  }

  for (const row of rows) {
    if (row.ok) continue;
    console.log('');
    console.log(row.plugin + ' rejects ' + row.runtime + ':');
    for (const [peer, range] of Object.entries(row.peers)) {
      console.log('  ' + peer + ' requires ' + range);
    }
  }

  console.log('');
  if (rows.length > 0 && rows.every((row) => row.checked === false)) {
    console.log('nothing was verified: no @deepseek-ai/dsh* peers are declared.');
    console.log('');
  }
  const home = process.env.HOME;
  const where = home && resolved.appBoot.startsWith(home) ? '~' + resolved.appBoot.slice(home.length) : resolved.appBoot;
  console.log('evaluated with ' + where + ' (installed runtime ' + evaluator.runtimeVersion + ')');
  if (failed) {
    console.log('');
    console.log(REMEDY);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(2);
});
