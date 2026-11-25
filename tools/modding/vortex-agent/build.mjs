import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import paths from './paths.cjs';
export const PIN = 'd10277b8858ad6d411765aa93131219f4a24533e';
const CACHE = paths.cache;
const BUILD = paths.build;
const source = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(source, '../../../dependencies/vortex-mcp');
const packageInputs = {
  'index.js': 'adapted-dist/index.js',
  'LICENSE.md': 'LICENSE.md',
  'THIRD-PARTY-NOTICES.md': 'THIRD-PARTY-NOTICES.md',
};
const packageNames = new Set([...Object.keys(packageInputs), 'info.json', 'provenance.json']);
const modules = ['paths.cjs', 'paths-core.cjs', 'guard.cjs', 'extension.cjs', 'credential.cjs', 'inspection.cjs', 'lifecycle-inspection.cjs', 'native-preflight.cjs', 'serialization.cjs', 'download-identity.cjs', 'receipts.cjs', 'http-ingress.cjs', 'own-zip.cjs', 'local-archive-policy.cjs', 'local-archive-install.cjs', 'local-install-host.cjs', 'local-install-binding.cjs', 'official-vortex-hosts.cjs', 'stock-vortex-2.9.1-admission.json', 'stock-vortex-2.10.1-admission.json', 'stock-vortex-2.11.0-admission.json', 'install-diagnostics.cjs', 'installed-candidate-assessment.cjs', 'collection-wizard-controller.cjs', 'collection-wizard-dom.cjs', 'collection-wizard-native.cjs', 'collection-wizard-policy.cjs', 'collection-wizard-host.cjs', 'collection-dialog-controller.cjs', 'collection-dialog-policy.cjs', 'collection-update-prompt.cjs', 'native-dialog-controller.cjs', 'native-dialog-host-admission.cjs', 'native-dialog-operations.cjs'];
modules.push('mod-record-fingerprints.cjs', 'strict-json.cjs');
const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

async function noReparsePaths(...files) {
  for (const file of files) {
    const ancestry = [];
    for (let entry = path.resolve(file); ; entry = path.dirname(entry)) {
      ancestry.unshift(entry);
      if (entry === path.dirname(entry)) break;
    }
    for (const entry of ancestry) {
      try {
        const info = await fs.lstat(entry);
        if (info.isSymbolicLink()) throw Error('Build reparse path refused');
        if (info.isFile() && info.nlink !== 1) throw Error('Build hardlink path refused');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

async function noReparseTree(directory) {
  await noReparsePaths(directory);
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    await noReparsePaths(file);
    if (entry.isDirectory()) await noReparseTree(file);
  }
}

export async function verifyPinnedSnapshot(tree) {
  await noReparsePaths(path.join(tree, 'UPSTREAM-PROVENANCE.json'));
  const provenance = JSON.parse(await fs.readFile(path.join(tree, 'UPSTREAM-PROVENANCE.json'), 'utf8'));
  if (provenance.upstream !== 'https://github.com/alandtse/vortex-mcp' || provenance.commit !== PIN
      || provenance.license !== 'GPL-3.0-only' || !provenance.currentFileSHA256
      || !provenance.originalFileSHA256 || !Array.isArray(provenance.localChanges))
    throw Error('Pinned upstream snapshot provenance is incomplete');
  const pins = provenance.currentFileSHA256;
  if (!Object.keys(pins).length) throw Error('Pinned upstream snapshot is empty');
  const changes = provenance.localChanges.map(change => typeof change === 'string' ? change : change?.path);
  const expected = [...Object.keys(pins), 'UPSTREAM-PROVENANCE.json'].sort();
  if (!Array.isArray(provenance.expectedPublicFiles)
      || JSON.stringify([...provenance.expectedPublicFiles].sort()) !== JSON.stringify(expected))
    throw Error('Pinned upstream public fileset differs');
  for (const [name, original] of Object.entries(provenance.originalFileSHA256)) {
    if (!Object.hasOwn(pins, name) || (pins[name] !== original && !changes.includes(name)))
      throw Error('Upstream original/accepted pins are inconsistent: ' + name);
  }
  for (const [name, pin] of Object.entries(pins)) {
    const parts = name.split('/');
    if (!name || /[\\:\x00-\x1f]/.test(name) || parts.some(p => !p || ['.', '..', '.git', 'node_modules', '.tooling'].includes(p))
        || !/^[a-f0-9]{64}$/.test(pin)) throw Error('Unsafe pinned upstream path');
    const file = path.join(tree, ...parts);
    for (let entry = file; entry !== path.dirname(entry); entry = path.dirname(entry)) {
      if ((await fs.lstat(entry)).isSymbolicLink()) throw Error('Pinned upstream reparse path refused');
      if (entry === path.resolve(tree)) break;
    }
    if (!(await fs.stat(file)).isFile() || await sha(file) !== pin) throw Error('Pinned upstream content differs: ' + name);
  }
  const accepted = crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(
    Object.keys(pins).sort().map(name => [name, pins[name]])))).digest('hex');
  if (accepted !== provenance.acceptedSourceTreeSHA256) throw Error('Accepted upstream source-tree pin differs');
  return provenance;
}

async function checkBuildTree(tree) {
  let snapshot = false;
  try { await fs.access(path.join(tree, 'UPSTREAM-PROVENANCE.json')); snapshot = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (snapshot) return verifyPinnedSnapshot(tree);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim();
  if (head !== PIN) throw Error('Upstream pin differs');
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'package.json', 'pnpm-lock.yaml', 'src/vortexControl.ts'], { cwd: tree, stdio: 'pipe' });
  return { commit: PIN, sourceMethod: 'pinned local Git clone' };
}

export function runtimeWorkspace(env = process.env) {
  return paths.absolute(env.NEXUS_RUNTIME_WORKSPACE === undefined ? paths.workspace
    : env.NEXUS_RUNTIME_WORKSPACE, 'NEXUS_RUNTIME_WORKSPACE');
}

export function adaptedConfig(config, workspace = runtimeWorkspace()) {
  if (!config.includes('entry: { index: "src/index.ts" }') || !config.includes('outDir: "dist"'))
    throw Error('Unexpected upstream build config');
  const root = paths.absolute(workspace, 'NEXUS_WORKSPACE');
  return config.replace('src/index.ts', 'src/adapted.cjs').replace('outDir: "dist"', 'outDir: "adapted-dist"')
    .replace('external: ["electron", "@nexusmods/vortex-api"]', 'external: ["electron", "original-fs", "@nexusmods/vortex-api"]')
    .replace('export default defineConfig({', 'export default defineConfig({\n  define: { __NEXUS_WORKSPACE__: '
      + JSON.stringify(JSON.stringify(root)) + ' },');
}

export async function compileInputs(tree, workspace = runtimeWorkspace()) {
  const runtime = paths.absolute(workspace, 'NEXUS_RUNTIME_WORKSPACE');
  const names = [...modules.map(n => 'src/' + n), 'src/adapted.cjs', 'tsup.adapted.config.ts',
    'tsup.config.ts', 'package.json', 'pnpm-lock.yaml', 'src/vortexControl.ts'];
  await noReparsePaths(...names.map(name => path.join(tree, name)));
  const config = await fs.readFile(path.join(tree, 'tsup.config.ts'), 'utf8');
  if (await fs.readFile(path.join(tree, 'tsup.adapted.config.ts'), 'utf8') !== adaptedConfig(config, runtime))
    throw Error('Workspace or generated build configuration changed; patch again');
  const inputs = {};
  for (const name of names) inputs[name] = await sha(path.join(tree, name));
  return { workspaceRoot: runtime, inputs };
}

export function assertCompileReceipt(receipt, current, bundleSha256) {
  if (!receipt || receipt.bundleSha256 !== bundleSha256 || JSON.stringify(receipt.inputs) !== JSON.stringify(current))
    throw Error('Compiled bundle/source/workspace proof differs; rebuild before packaging');
}
async function checkPackageOutput(plugin) {
  let entries;
  try { entries = await fs.readdir(plugin, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return; }
  for (const entry of entries) {
    if (!entry.isFile() || !packageNames.has(entry.name))
      throw Error('Unexpected package output: ' + entry.name);
  }
}

async function preservePreviousBuild(plugin) {
  let previous;
  try { previous = JSON.parse(await fs.readFile(path.join(plugin, 'provenance.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (previous?.version === '1.1.0') return;
  if (!['1.0.3', '1.0.4'].includes(previous?.version) || !previous.sources
      || typeof previous.sources !== 'object' || Array.isArray(previous.sources))
    throw Error('Unsupported previous package provenance');
  await checkPackageOutput(plugin);
  const allowedSources = new Set([...modules, 'build.mjs', 'bridge.mjs', 'manage-install.py']);
  const sourceEntries = Object.entries(previous.sources);
  if (!sourceEntries.length || sourceEntries.some(([name, pin]) =>
    !allowedSources.has(name) || typeof pin !== 'string' || !/^[a-f0-9]{64}$/.test(pin)))
    throw Error('Invalid previous package source provenance');
  const retainedSources = sourceEntries.filter(([name]) => name.endsWith('.cjs'));
  const digest = await sha(path.join(plugin, 'index.js'));
  if (digest !== previous.pluginSha256) throw Error('Previous package provenance mismatch');
  const archive = path.join(BUILD, 'archives', previous.version + '-' + digest);
  const verifyArchiveInputs = async (sources, compiled) => {
    const pins = [[path.join(compiled, 'index.js'), digest],
      ...retainedSources.map(([name, pin]) => [path.join(sources, name), pin])];
    for (const [file, pin] of pins) {
      await noReparsePaths(file);
      if (await sha(file) !== pin) throw Error('Previous build copy differs');
    }
  };
  await noReparsePaths(archive);
  let existing;
  try { existing = await fs.lstat(archive); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    try {
      const archivedPlugin = path.join(archive, 'plugin/index.js');
      await noReparsePaths(archivedPlugin);
      if (!existing.isDirectory() || await sha(archivedPlugin) !== digest) throw Error('Previous archived bundle differs');
      await verifyArchiveInputs(path.join(archive, 'src'), path.join(archive, 'adapted-dist'));
    } catch {
      throw Error('Previous archive incomplete or mismatched; inspect before rebuilding');
    }
    return;
  }
  const copiedSources = path.join(BUILD, 'upstream/src');
  const compiled = path.join(BUILD, 'upstream/adapted-dist');
  await verifyArchiveInputs(copiedSources, compiled);
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.mkdir(archive);
  await fs.cp(plugin, path.join(archive, 'plugin'), { recursive: true, errorOnExist: true, force: false });
  await fs.cp(compiled, path.join(archive, 'adapted-dist'), { recursive: true, errorOnExist: true, force: false });
  await fs.mkdir(path.join(archive, 'src'));
  for (const [name] of retainedSources)
    await fs.copyFile(path.join(copiedSources, name), path.join(archive, 'src', name), fs.constants.COPYFILE_EXCL);
}
const run = (cmd, args, cwd = BUILD) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd.endsWith('.cmd') });
async function directoryIdentity(directory) {
  const info = await fs.lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Build directory changed');
  return `${info.dev}:${info.ino}`;
}

async function requireNewTree(tree) {
  try { await fs.lstat(tree); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Error('Build tree already exists; inspect it rather than overwrite');
}

async function materializeBuildTree(target, snapshot) {
  if (snapshot) {
    for (const name of Object.keys(snapshot.currentFileSHA256)) {
      const destination = path.join(target, ...name.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(vendor, ...name.split('/')), destination, fs.constants.COPYFILE_EXCL);
    }
    await fs.copyFile(path.join(vendor, 'UPSTREAM-PROVENANCE.json'), path.join(target, 'UPSTREAM-PROVENANCE.json'), fs.constants.COPYFILE_EXCL);
  } else {
    run('git', ['clone', '--no-hardlinks', CACHE, target]);
    run('git', ['checkout', '--detach', PIN], target);
  }
  const prepared = await checkBuildTree(target);
  if (snapshot && prepared.acceptedSourceTreeSHA256 !== snapshot.acceptedSourceTreeSHA256)
    throw Error('Pinned upstream source changed while copying');
}

async function prepareBuildTree(tree) {
  await fs.mkdir(BUILD, { recursive: true });
  const buildIdentity = await directoryIdentity(BUILD);
  await requireNewTree(tree);
  let hasVendor = true;
  try { await fs.access(vendor); }
  catch (error) { if (error.code !== 'ENOENT') throw error; hasVendor = false; }
  const snapshot = hasVendor ? await verifyPinnedSnapshot(vendor) : null;
  if (process.platform !== 'win32') {
    // POSIX rename can replace an empty competing directory. Retain exclusive
    // direct creation there rather than overwrite another writer's entry.
    await noReparsePaths(tree);
    if (await directoryIdentity(BUILD) !== buildIdentity) throw Error('Build directory changed during preparation');
    await fs.mkdir(tree);
    await materializeBuildTree(tree, snapshot);
    return;
  }

  const pending = await fs.mkdtemp(path.join(BUILD, 'upstream-pending-'));
  const pendingIdentity = await directoryIdentity(pending);
  await materializeBuildTree(pending, snapshot);

  await noReparsePaths(pending, tree);
  if (await directoryIdentity(BUILD) !== buildIdentity || await directoryIdentity(pending) !== pendingIdentity)
    throw Error('Build directory changed before publication');
  await requireNewTree(tree);
  // A complete tree is published at once. Windows rename cannot replace an
  // ordinary directory that was created by another writer at this path.
  await fs.rename(pending, tree);
  if (await directoryIdentity(BUILD) !== buildIdentity || await directoryIdentity(tree) !== pendingIdentity)
    throw Error('Prepared build directory changed during publication');
}

export async function main(argv = process.argv.slice(2)) {
  const phases = ['--prepare', '--regression', '--patch', '--compile', '--package'];
  const [phase] = argv;
  if (argv.length !== 1 || !phases.includes(phase))
    throw Error('Usage: build.mjs ' + phases.join(' | '));
  // COPYFILE_EXCL protects new files only. Existing adapted inputs and outputs
  // also need ancestry checks before any write can follow a planted link.
  const buildTree = path.join(BUILD, 'upstream');
  await noReparsePaths(BUILD, path.join(BUILD, 'adapted-compile.json'),
    ...[...modules, 'adapted.cjs', 'regression.test.ts'].map(name => path.join(buildTree, 'src', name)),
    path.join(buildTree, 'tsup.adapted.config.ts'));
  await noReparseTree(path.join(buildTree, 'adapted-dist'));
  await noReparseTree(path.join(BUILD, 'plugin/vortex-agent'));
if (phase === '--prepare') {
  await prepareBuildTree(buildTree);
} else if (phase === '--regression') {
  await fs.copyFile(path.join(source, 'regression.test.ts'), path.join(BUILD, 'upstream', 'src', 'regression.test.ts'));
} else if (phase === '--patch') {
  await preservePreviousBuild(path.join(BUILD, 'plugin/vortex-agent'));
  const tree = path.join(BUILD, 'upstream');
  await checkBuildTree(tree);
  for (const name of modules) await fs.copyFile(path.join(source, name), path.join(tree, 'src', name));
  await fs.writeFile(path.join(tree, 'src', 'adapted.cjs'), "const { start } = require('./extension.cjs');\nmodule.exports = function(context) { context.once(() => start(context.api)); return true; };\nmodule.exports.start = start;\n");
  const config = await fs.readFile(path.join(tree, 'tsup.config.ts'), 'utf8');
  await fs.writeFile(path.join(tree, 'tsup.adapted.config.ts'), adaptedConfig(config));
} else if (phase === '--compile') {
  const tree = path.join(BUILD, 'upstream');
  await checkBuildTree(tree);
  const inputs = await compileInputs(tree);
  run(process.execPath, [path.join(tree, 'node_modules/tsup/dist/cli-default.js'), '--config', 'tsup.adapted.config.ts'], tree);
  if (JSON.stringify(await compileInputs(tree)) !== JSON.stringify(inputs)) throw Error('Build inputs changed while compiling');
  await fs.writeFile(path.join(BUILD, 'adapted-compile.json'), JSON.stringify({ inputs,
    bundleSha256: await sha(path.join(tree, 'adapted-dist/index.js')) }, null, 2));
} else if (phase === '--package') {
  const tree = path.join(BUILD, 'upstream');
  const upstream = await checkBuildTree(tree);
  const current = await compileInputs(tree);
  const packageFiles = {};
  for (const [name, input] of Object.entries(packageInputs)) {
    const file = path.join(tree, input);
    await noReparsePaths(file);
    packageFiles[name] = await fs.readFile(file);
  }
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const bundleSha256 = hash(packageFiles['index.js']);
  assertCompileReceipt(JSON.parse(await fs.readFile(path.join(BUILD, 'adapted-compile.json'), 'utf8')), current, bundleSha256);
  const sources = {};
  for (const name of [...modules, 'build.mjs', 'bridge.mjs', 'manage-install.py']) sources[name] = await sha(path.join(source, name));
  for (const name of modules) if (current.inputs['src/' + name] !== sources[name]) throw Error('Build copy differs: ' + name);
  const licenseFileSHA256 = {};
  for (const name of ['LICENSE.md', 'THIRD-PARTY-NOTICES.md']) {
    licenseFileSHA256[name] = hash(packageFiles[name]);
    if (upstream.currentFileSHA256 && licenseFileSHA256[name] !== upstream.currentFileSHA256[name])
      throw Error('Pinned upstream content differs: ' + name);
  }
  packageFiles['info.json'] = JSON.stringify({ id: 'vortex-agent', name: 'Vortex Agent (guarded MCP)', author: 'Alan Tse; local adapted fork', version: '1.1.0', description: 'DPAPI-authenticated curated MCP adapter; reviewed own-local ZIP installation; external deployment verification required', type: 'extension' }, null, 2);
  packageFiles['provenance.json'] = JSON.stringify({ upstream: 'https://github.com/alandtse/vortex-mcp', commit: PIN,
    maintainedSource: source, workspaceRoot: current.workspaceRoot, protocol: 'vortex-agent/1', version: '1.1.0', installSupported: false, receiptVersion: 2,
    packageSchemaVersion: 2, licenseFileSHA256,
    sourceOffer: { repository: 'https://github.com/Antrakt92/vortex-nexus-modding-mcp',
      description: 'Corresponding adapter source, build scripts, upstream source pins and dependency lockfile.' },
    authentication: 'Windows-DPAPI-CurrentUser-bearer', vortexSourceCommit: '41be6d4556568a605d6131b8c5ca90ff26dec6ac',
    pluginSha256: bundleSha256, lockfileSha256: current.inputs['pnpm-lock.yaml'],
    upstreamControlSha256: current.inputs['src/vortexControl.ts'], sources }, null, 2);
  // A validation failure must leave any existing candidate package intact.
  const plugin = path.join(BUILD, 'plugin', 'vortex-agent');
  await checkPackageOutput(plugin);
  await preservePreviousBuild(plugin);
  await fs.mkdir(plugin, { recursive: true });
  for (const [name, data] of Object.entries(packageFiles)) {
    const destination = path.join(plugin, name);
    await noReparsePaths(destination);
    await fs.writeFile(destination, data);
  }
  console.log(plugin);
}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
});
