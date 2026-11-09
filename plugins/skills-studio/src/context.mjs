import { createHash } from 'node:crypto';
import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';

let tokenizer;
const encode = text => (tokenizer ||= new Tiktoken(ranks)).encode(text, [], []).length;
export const CONTEXT_MEASUREMENT_LIMITS = Object.freeze({ maxBytes:128 * 1024, maxRunLength:4096, maxMergeWork:1_000_000 });

function limitReason(text) {
  if (Buffer.byteLength(text, 'utf8') > CONTEXT_MEASUREMENT_LIMITS.maxBytes) return 'byte-limit';
  // Long whitespace pieces can also reach the quadratic merge routine.
  let mergeWork = 0;
  for (const run of text.matchAll(/\S+|\s+/gu)) {
    if (run[0].length > CONTEXT_MEASUREMENT_LIMITS.maxRunLength) return 'long-run';
    // BPE rescans pairs after each merge. A cumulative square bound prevents
    // many individually allowed runs from monopolizing the MCP event loop.
    mergeWork += Buffer.byteLength(run[0], 'utf8') ** 2;
    if (mergeWork > CONTEXT_MEASUREMENT_LIMITS.maxMergeWork) return 'work-limit';
  }
  return null;
}

const hash = text => createHash('sha256').update(text).digest('hex');

// The descriptor approximates the discoverable catalogue, not Codex's complete
// request prompt. Loading instructions is a separate, optional context expense.
export function skillDescriptor(skill) {
  return `- ${skill.name}: ${skill.description} (file: ${skill.path})`;
}

export function createContextMeasurer({ maxEntries = 512, countTokens = encode } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer');
  const cache = new Map();
  function count(text) {
    const key = hash(text);
    if (cache.has(key)) {
      const result = cache.get(key);
      cache.delete(key); cache.set(key, result);
      return result;
    }
    const result = countTokens(text);
    cache.set(key, result);
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return result;
  }
  const measure = (skill, content) => {
    const descriptor = skillDescriptor(skill);
    const metadataLimitReason = limitReason(descriptor);
    const instructionLimitReason = typeof content === 'string' ? limitReason(content) : null;
    return {
      metadataTokens:metadataLimitReason ? null : count(descriptor),
      instructionTokens:typeof content === 'string' && !instructionLimitReason ? count(content) : null,
      ...(metadataLimitReason ? { metadataLimitReason } : {}),
      ...(instructionLimitReason ? { instructionLimitReason } : {}),
    };
  };
  return measure;
}

export const measureSkillContext = createContextMeasurer();

export function summarizeContext(skills) {
  const excluded = { disabled:0, cached:0, unknown:0, invalid:0 }, entries = [];
  for (const skill of skills) {
    const status = skill.availability?.status;
    if (skill.disabled || status === 'disabled') { excluded.disabled++; continue; }
    if (status === 'cached') { excluded.cached++; continue; }
    if (status !== 'enabled') { excluded.unknown++; continue; }
    if (skill.validationError || typeof skill.description !== 'string' || !skill.description.trim() || typeof skill.name !== 'string' || !skill.name.trim()) { excluded.invalid++; continue; }
    const context = skill.context || {};
    entries.push({ id:skill.id, name:skill.name, source:skill.source, ...(skill.sourceKind ? {sourceKind:skill.sourceKind} : {}), scope:skill.scope, path:skill.path,
      metadataTokens:Number.isFinite(context.metadataTokens) ? context.metadataTokens : null,
      instructionTokens:Number.isFinite(context.instructionTokens) ? context.instructionTokens : null });
  }
  entries.sort((a, b) => (b.metadataTokens ?? -1) - (a.metadataTokens ?? -1) || a.name.localeCompare(b.name));
  const sum = field => entries.some(entry => entry[field] === null) ? null : entries.reduce((total, entry) => total + entry[field], 0);
  return { method:'o200k_base', estimated:true, totalCount:skills.length, enabledCount:entries.length,
    measuredCount:entries.filter(entry => entry.metadataTokens !== null).length, excluded,
    metadataTokens:sum('metadataTokens'), instructionTokens:sum('instructionTokens'), entries };
}
