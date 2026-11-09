import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLocationActions } from '../src/locations.mjs';

function nativeStub() {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (input, encoding) => { child.input = input; child.encoding = encoding; };
    child.kill = signal => { child.killed = signal; };
    calls.push({ command, args, options, child });
    return child;
  };
  return { calls, spawnProcess };
}

test('native actions pass special paths as stdin or arguments and await successful exit', async () => {
  const stub = nativeStub();
  const actions = createLocationActions({platform:'darwin', spawnProcess:stub.spawnProcess});
  const path = '/tmp/skill "quoted" $(touch nope) $HOME/SKILL.md';
  let completed = false;
  const copied = actions.copyPath(path).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  const copy = stub.calls[0];
  assert.equal(copy.command, '/usr/bin/pbcopy');
  assert.deepEqual(copy.args, []);
  assert.deepEqual(copy.options, {shell:false, stdio:['pipe','ignore','ignore']});
  assert.equal(copy.child.input, path);
  assert.equal(copy.child.encoding, 'utf8');
  copy.child.emit('close', 0, null);
  await copied;
  const opened = actions.openTerminal(path);
  const terminal = stub.calls[1];
  assert.equal(terminal.command, '/usr/bin/open');
  assert.deepEqual(terminal.args, ['-a','Terminal',path]);
  assert.deepEqual(terminal.options, {shell:false, stdio:['ignore','ignore','ignore']});
  terminal.child.emit('close', 0, null);
  await opened;
});

test('native actions report unsupported platforms without spawning', async () => {
  const stub = nativeStub();
  const actions = createLocationActions({platform:'linux', spawnProcess:stub.spawnProcess});
  await assert.rejects(actions.copyPath('/tmp/SKILL.md'), {code:'UNSUPPORTED_PLATFORM'});
  await assert.rejects(actions.openTerminal('/tmp'), {code:'UNSUPPORTED_PLATFORM'});
  assert.equal(stub.calls.length, 0);
});

test('clipboard reports exit, spawn and stdin failures with localized bounded errors', async () => {
  for (const fail of [child => child.emit('close', 1, null), child => child.emit('error', new Error('x'.repeat(100000))), child => child.stdin.emit('error', new Error('broken pipe'))]) {
    const stub = nativeStub();
    const actions = createLocationActions({platform:'darwin', spawnProcess:stub.spawnProcess});
    const result = actions.copyPath('/tmp/SKILL.md');
    fail(stub.calls[0].child);
    await assert.rejects(result, error => error.code === 'LOCATION_ACTION_FAILED' && error.message.length < 200 && error.message.includes('буфер обмена'));
  }
});

test('native process timeout kills the child and settles the operation', async () => {
  const stub = nativeStub();
  const actions = createLocationActions({platform:'darwin', spawnProcess:stub.spawnProcess, timeoutMs:5});
  await assert.rejects(actions.copyPath('/tmp/SKILL.md'), {code:'LOCATION_ACTION_TIMEOUT'});
  assert.equal(stub.calls[0].child.killed, 'SIGKILL');
  stub.calls[0].child.emit('close', null, 'SIGKILL');
});
