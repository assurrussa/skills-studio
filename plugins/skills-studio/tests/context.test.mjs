import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';
import { createContextMeasurer, measureSkillContext, skillDescriptor, summarizeContext } from '../src/context.mjs';
import { SkillStore } from '../src/store.mjs';

const skill = (id, status = 'enabled', extra = {}) => ({ id, name:'Одинаковое имя', description:'Разбор запроса 🐈', path:`/skills/${id}/SKILL.md`, source:'Личные', scope:'global', availability:{status}, ...extra });
const document = '---\nname: sample\ndescription: Пример\n---\nИнструкции <|endoftext|> 🐈\n';

test('reference o200k tokenizer treats unicode and special-token-looking text literally', () => {
  const input = skill('unicode'); const encoder = new Tiktoken(ranks);
  const measured = measureSkillContext(input,document);
  assert.equal(measured.metadataTokens,encoder.encode(skillDescriptor(input),[],[]).length);
  assert.equal(measured.instructionTokens,encoder.encode(document,[],[]).length);
  assert.equal(measureSkillContext(input,null).instructionTokens,null);
});

test('baseline is metadata only; adding instructions does not change it', () => {
  const input = skill('body');
  const before = {...input,context:measureSkillContext(input,'short')};
  const after = {...input,context:measureSkillContext(input,'long instructions '.repeat(1000))};
  const initial = summarizeContext([before]), changed = summarizeContext([after]);
  assert.equal(changed.method,'o200k_base'); assert.equal(changed.estimated,true);
  assert.equal(changed.metadataTokens,initial.metadataTokens);
  assert.ok(changed.instructionTokens > initial.instructionTokens);
  assert.notEqual(changed.metadataTokens,changed.metadataTokens + changed.instructionTokens);
});

test('summary partitions disabled, cached, unknown and invalid and retains same-name independent skills', () => {
  const inputs = [skill('one'),skill('two'),skill('disabled','disabled'),skill('cached','cached'),skill('unknown','unknown'),skill('invalid','enabled',{validationError:'Invalid YAML'})];
  inputs.forEach(input => {input.context = measureSkillContext(input,document);});
  inputs[1].context.metadataTokens += 10;
  inputs[1].sourceKind = 'name';
  const result = summarizeContext(inputs);
  assert.equal(result.enabledCount,2); assert.deepEqual(result.excluded,{disabled:1,cached:1,unknown:1,invalid:1});
  assert.equal(result.totalCount,6); assert.equal(result.measuredCount,2);
  assert.deepEqual(result.entries.map(entry => entry.id),['two','one']);
  assert.equal(result.entries.find(entry=>entry.id==='two').sourceKind,'name');
  assert.equal(result.metadataTokens,inputs[0].context.metadataTokens + inputs[1].context.metadataTokens);
});

test('missing measurements stay null rather than becoming zero in totals', () => {
  const input = skill('unreadable'); input.context = measureSkillContext(input,null);
  const result = summarizeContext([input]);
  assert.equal(result.entries[0].instructionTokens,null); assert.equal(result.instructionTokens,null);
  assert.ok(result.metadataTokens > 0);
  assert.equal(summarizeContext([skill('missing')]).metadataTokens,null);
  assert.equal(summarizeContext([skill('missing')]).measuredCount,0);
});

test('hash-keyed LRU reuses counts and bounds retained entries', () => {
  const counted = [];
  const measure = createContextMeasurer({maxEntries:2,countTokens:text => {counted.push(text); return text.length;}});
  const first = skill('first');
  measure(first,'first body'); measure(first,'first body');
  assert.equal(counted.length,2);
  measure(skill('second'),'second body'); assert.equal(counted.length,4);
  measure(first,'first body'); assert.equal(counted.length,6);
  assert.throws(() => createContextMeasurer({maxEntries:0}),RangeError);
});

test('store uses existing read to measure all records, deduplicates canonical aliases, handles oversized bodies', async t => {
  const home = await mkdtemp(join(tmpdir(),'skill-context-')); t.after(() => rm(home,{recursive:true,force:true}));
  const codexHome = join(home,'.codex'), root = join(home,'.agents/skills');
  for (const name of ['sample','large','invalid']) await mkdir(join(root,name),{recursive:true});
  const path = join(root,'sample/SKILL.md'); await writeFile(path,document);
  await writeFile(join(root,'large/SKILL.md'),'x'.repeat(2 * 1024 * 1024 + 1));
  await writeFile(join(root,'invalid/SKILL.md'),'not YAML');
  await mkdir(join(codexHome,'skills'),{recursive:true}); await symlink(join(root,'sample'),join(codexHome,'skills/alias'));
  const runtime = {snapshot:async () => ({data:[{skills:[{path,enabled:true}]}]})};
  const store = new SkillStore({home,codexHome,runtime});
  const {skills} = await store.listSkills();
  const regular = skills.find(input => input.path === path);
  assert.equal(regular.registrations.length,2); assert.equal(regular.context.instructionTokens,measureSkillContext(regular,document).instructionTokens);
  assert.equal(skills.find(input => input.path.includes('/large/')).context.instructionTokens,null);
  assert.ok(skills.find(input => input.path.includes('/invalid/')).validationError);
  assert.equal(summarizeContext(skills).enabledCount,1);
  assert.equal(skills.filter(input => input.name === 'sample').length,1);
});

test('tokenization rejects oversized bytes and long BPE runs before invoking encoder', () => {
  const encoded = [];
  const measure = createContextMeasurer({countTokens:text => {encoded.push(text); return text.length;}});
  const input = skill('bounded');
  const byteLimited = measure(input, '🦊 '.repeat(32768));
  assert.equal(byteLimited.instructionTokens,null); assert.equal(byteLimited.instructionLimitReason,'byte-limit');
  assert.equal(encoded.length,1);
  for (const run of ['x'.repeat(4097), ' '.repeat(4097), '\n'.repeat(4097)]) {
    const measured = measure(input,run);
    assert.equal(measured.instructionTokens,null); assert.equal(measured.instructionLimitReason,'long-run');
  }
  assert.equal(encoded.length,1);
  const edge = measure(input,'x'.repeat(1000)); assert.equal(edge.instructionTokens,1000);
  assert.equal(edge.instructionLimitReason,undefined);
  assert.equal(measure(input,'x'.repeat(1001)).instructionLimitReason,'work-limit');
  const oversizedDescriptor = measure({...input,description:'x'.repeat(4097)},'safe body');
  assert.equal(oversizedDescriptor.metadataTokens,null); assert.equal(oversizedDescriptor.metadataLimitReason,'long-run');
  assert.equal(oversizedDescriptor.instructionTokens,9);
  const invalidSummary = summarizeContext([{...input,context:oversizedDescriptor}]);
  assert.equal(invalidSummary.metadataTokens,null);
});

test('measurement byte cap is inclusive and applies to descriptor too', () => {
  const measure = createContextMeasurer({countTokens:text => text.length});
  const body = 'x '.repeat(65536);
  assert.equal(measure(skill('edge'),body).instructionTokens,131072);
  assert.equal(measure(skill('over'),body+' ').instructionTokens,null);
  const huge = measure(skill('huge','enabled',{description:'x '.repeat(65536)}),'body');
  assert.equal(huge.metadataTokens,null); assert.equal(huge.metadataLimitReason,'byte-limit');
});

test('cumulative merge budget skips repeated allowed runs before synchronous BPE',()=>{
 const content=('x'.repeat(4096)+' ').repeat(31);
 const measured=measureSkillContext(skill('worst-case'),content);
 assert.equal(measured.instructionTokens,null);assert.equal(measured.instructionLimitReason,'work-limit');
 const manyRuns=('x'.repeat(512)+' ').repeat(20);
 assert.equal(measureSkillContext(skill('many-runs'),manyRuns).instructionLimitReason,'work-limit');
});
