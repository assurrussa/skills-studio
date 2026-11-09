import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SkillHealth } from '../src/health.mjs';
const exec = promisify(execFile);
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skill-health-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'skill'); await mkdir(directory);
  const path = join(directory, 'SKILL.md'); await writeFile(path, '# Sample\n');
  return { root, directory, path, skill: { id: 'sample', path }, health: new SkillHealth({ stateDir: join(root, 'state'), ...options }) };
}

test('inspection is local-only and reviews include assets and references', async t => {
  const f = await fixture(t, { exec: () => { throw new Error('must not execute'); } });
  await mkdir(join(f.directory, 'assets'));
  await writeFile(join(f.directory, 'assets', 'sample.bin'), Buffer.from([1, 2, 3]));
  const before = await f.health.inspect(f.skill);
  assert.equal(before.review, null); assert.equal(before.sourceCheck, null);
  await f.health.saveReview(f.skill, { fingerprint: before.fingerprint, note: 'Checked instructions', evidenceUrls: ['https://example.com/docs'] });
  assert.equal((await f.health.inspect(f.skill)).review.state, 'reviewed');
  await writeFile(join(f.directory, 'assets', 'sample.bin'), Buffer.from([1, 2, 4]));
  assert.equal((await f.health.inspect(f.skill)).review.state, 'changed');
  await assert.rejects(f.health.saveReview(f.skill, { fingerprint: before.fingerprint, note: 'Stale' }), { code: 'CONFLICT' });
});

test('local checks report explicit broken references and invalid metadata', async t => {
  const f = await fixture(t);
  await writeFile(f.path, '[Missing](references/missing.md)\n[Online](https://example.com)\n[Anchor](#name)\n');
  const result = await f.health.inspect({ ...f.skill, validationError: 'YAML invalid' });
  assert.deepEqual(result.checks.map(x => x.code), ['MISSING_REFERENCE', 'INVALID_SKILL']);
});

test('symlink references are fingerprinted and cycles cannot be marked reviewed', async t => {
  const f = await fixture(t);
  const external = join(f.root, 'external'); await mkdir(external); await writeFile(join(external, 'ref.md'), 'one');
  await symlink(external, join(f.directory, 'references'));
  const first = await f.health.inspect(f.skill);
  await writeFile(join(external, 'ref.md'), 'two');
  assert.notEqual((await f.health.inspect(f.skill)).fingerprint, first.fingerprint);
  await symlink(f.directory, join(f.directory, 'cycle'));
  assert.equal((await f.health.inspect(f.skill)).fingerprint, null);
  await assert.rejects(f.health.saveReview(f.skill, { fingerprint: null, note: 'Cannot establish' }), { code: 'CONFLICT' });
});

test('bounded content fails closed; only Git metadata is excluded', async t => {
  const f = await fixture(t, { maxBytes: 40 });
  const first = await f.health.inspect(f.skill);
  await mkdir(join(f.directory, '.git')); await writeFile(join(f.directory, '.git', 'large'), 'x'.repeat(100));
  assert.equal((await f.health.inspect(f.skill)).fingerprint, first.fingerprint);
  await mkdir(join(f.directory, 'node_modules'));
  await writeFile(join(f.directory, 'node_modules', 'large'), 'x'.repeat(100));
  const result = await f.health.inspect(f.skill);
  assert.equal(result.fingerprint, null); assert.equal(result.checks[0].code, 'INCOMPLETE_CONTENT');
});

test('review validation, atomic merge and id hashing protect state paths', async t => {
  const f = await fixture(t);
  const skill = { ...f.skill, id: '../../outside' };
  const { fingerprint } = await f.health.inspect(skill);
  for (const data of [{ note: '' }, { note: 'ok', evidenceUrls: ['file:///etc/passwd'] }, { note: 'ok', evidenceUrls: ['https://user:pass@example.com'] }]) {
    await assert.rejects(f.health.saveReview(skill, { fingerprint, ...data }), { code: 'INVALID_REVIEW' });
  }
  await Promise.all([f.health.saveReview(skill, { fingerprint, note: 'ok' }), f.health.checkSource(skill)]);
  const result = await f.health.inspect(skill);
  assert.equal(result.review.state, 'reviewed'); assert.equal(result.sourceCheck.status, 'unknown');
  assert.equal((await readdir(join(f.root, 'state', 'health'))).length, 1);
  const another = new SkillHealth({ stateDir: join(f.root, 'state') });
  assert.equal((await another.inspect(skill)).review.note, 'ok');
});

async function git(cwd, ...args) { return (await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd })).stdout.trim(); }
async function gitFixture(t) {
  const f = await fixture(t);
  const remote = join(f.root, 'remote'); await mkdir(remote);
  await git(remote, 'init', '-b', 'main');
  await mkdir(join(remote, 'skills', 'sample'), { recursive: true });
  await writeFile(join(remote, 'skills', 'sample', 'SKILL.md'), '# Sample\n');
  await git(remote, 'add', '.'); await git(remote, 'commit', '-m', 'initial');
  const local = join(f.root, 'local'); await git(f.root, 'clone', remote, local);
  return { ...f, remote, local, skill: { id: 'git-sample', path: join(local, 'skills', 'sample', 'SKILL.md'), git: { repository: local, trackedPath: 'skills/sample/SKILL.md' } } };
}

test('Git checks compare skill content and preserve checkout, index and refs', async t => {
  const f = await gitFixture(t);
  assert.equal((await f.health.checkSource(f.skill)).status, 'current');
  await writeFile(f.skill.path, '# Local edit\n');
  const localOnly = await f.health.checkSource(f.skill);
  assert.equal(localOnly.status, 'current'); assert.equal(localOnly.dirty, true);
  await writeFile(f.skill.path, '# Sample\n');
  await writeFile(join(f.remote, 'unrelated.md'), 'unrelated'); await git(f.remote, 'add', '.'); await git(f.remote, 'commit', '-m', 'unrelated');
  assert.equal((await f.health.checkSource(f.skill)).status, 'current');
  await writeFile(join(f.remote, 'skills', 'sample', 'SKILL.md'), '# Updated\n'); await git(f.remote, 'add', '.'); await git(f.remote, 'commit', '-m', 'skill');
  const refs = await git(f.local, 'show-ref'), index = await readFile(join(f.local, '.git', 'index'));
  const source = await f.health.checkSource(f.skill);
  assert.equal(source.status, 'update-available'); assert.equal(source.dirty, false);
  assert.equal(await git(f.local, 'show-ref'), refs);
  assert.deepEqual(await readFile(join(f.local, '.git', 'index')), index);
  assert.equal(await readFile(f.skill.path, 'utf8'), '# Sample\n');
  await writeFile(f.skill.path, '# Updated\n');
  const dirty = await f.health.checkSource(f.skill);
  assert.equal(dirty.status, 'update-available'); assert.equal(dirty.dirty, true);
});

test('unavailable Git upstream is unknown and persisted independently of review', async t => {
  const f = await gitFixture(t);
  await git(f.local, 'remote', 'set-url', 'origin', join(f.root, 'missing'));
  const result = await f.health.checkSource(f.skill);
  assert.equal(result.status, 'unknown');
  assert.equal((await f.health.inspect(f.skill)).sourceCheck.checkedAt, result.checkedAt);
});

test('plugin version check requires matching provider identity', async t => {
  const f = await fixture(t, { pluginProvider: async () => ({ pluginId: 'demo', version: '2' }) });
  const skill = { ...f.skill, plugin: { id: 'demo', version: '1' } };
  assert.equal((await f.health.checkSource(skill)).status, 'update-available');
  assert.equal((await f.health.checkSource({ ...skill, plugin: { id: 'other', version: '1' } })).status, 'unknown');
});


test('incomplete content cannot report a confirmed source version', async t => {
  const f = await fixture(t, { maxBytes: 1, pluginProvider: async () => ({ pluginId: 'demo', version: '1' }) });
  const result = await f.health.checkSource({ ...f.skill, plugin: { id: 'demo', version: '1' } });
  assert.equal(result.fingerprint, null); assert.equal(result.status, 'unknown');
});


test('Git source checks do not execute fsmonitor or clean filters', async t => {
  const f = await gitFixture(t);
  const monitor = join(f.root, 'monitor-marker'), clean = join(f.root, 'clean-marker');
  const script = join(f.root, 'fsmonitor.sh');
  await writeFile(script, `#!/bin/sh\ntouch '${monitor}'\n`, { mode: 0o700 });
  await git(f.local, 'config', 'core.fsmonitor', script);
  await git(f.local, 'config', 'filter.probe.clean', `touch '${clean}'; cat`);
  await git(f.local, 'config', 'filter.probe.process', `touch '${clean}'; exit 1`);
  await writeFile(join(f.local, '.git', 'info', 'attributes'), 'skills/sample/SKILL.md filter=probe\n');
  await writeFile(f.skill.path, '# Changed\n');
  const result = await f.health.checkSource(f.skill);
  assert.equal(result.status, 'current'); assert.equal(result.dirty, true);
  await assert.rejects(readFile(monitor), { code: 'ENOENT' });
  await assert.rejects(readFile(clean), { code: 'ENOENT' });
});
