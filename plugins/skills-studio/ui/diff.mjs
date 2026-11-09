function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function compareLines(before, after) {
  const result = [];
  const push = (kind, value) => result.push({ kind, value });
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) {
    push('context', before[start++]);
  }
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const oldLength = oldEnd - start, newLength = newEnd - start;
  // Bound memory and computation for large rewrites. The fallback still shows
  // every removed/added line; common leading and trailing lines stay context.
  if ((oldLength + 1) * (newLength + 1) > 4_000_000) {
    for (let i = start; i < oldEnd; i++) push('remove', before[i]);
    for (let i = start; i < newEnd; i++) push('add', after[i]);
  } else {
    const width = newLength + 1;
    const lengths = new Uint32Array((oldLength + 1) * width);
    for (let i = oldLength - 1; i >= 0; i--) {
      for (let j = newLength - 1; j >= 0; j--) {
        lengths[i * width + j] = before[start + i] === after[start + j]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < oldLength || j < newLength) {
      if (i < oldLength && j < newLength && before[start + i] === after[start + j]) {
        push('context', before[start + i]); i++; j++;
      } else if (i < oldLength && (j === newLength || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        push('remove', before[start + i++]);
      } else push('add', after[start + j++]);
    }
  }
  for (let i = oldEnd; i < before.length; i++) push('context', before[i]);
  return result;
}

export function createUnifiedDiff(before, after) {
  if (before === after) return { added: 0, removed: 0, hunks: [] };
  const operations = compareLines(splitLines(before), splitLines(after));
  const rows = [];
  let oldLine = 1, newLine = 1, added = 0, removed = 0;
  for (const { kind, value } of operations) {
    rows.push({ kind, text: value.replace(/\r?\n$/, ''), oldLine: kind === 'add' ? null : oldLine, newLine: kind === 'remove' ? null : newLine, oldBefore: oldLine, newBefore: newLine, noNewline: !value.endsWith('\n') });
    if (kind !== 'add') oldLine++;
    if (kind !== 'remove') newLine++;
    if (kind === 'add') added++;
    if (kind === 'remove') removed++;
  }
  const ranges = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'context') continue;
    const start = Math.max(0, i - 3), end = Math.min(rows.length, i + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = end;
    else ranges.push({ start, end });
  }
  const hunks = ranges.map(({ start, end }) => {
    const selected = rows.slice(start, end);
    const oldCount = selected.filter(line => line.kind !== 'add').length;
    const newCount = selected.filter(line => line.kind !== 'remove').length;
    const oldStart = selected[0].oldBefore - (oldCount ? 0 : 1);
    const newStart = selected[0].newBefore - (newCount ? 0 : 1);
    const lines = [];
    for (const { kind, text, oldLine, newLine, noNewline } of selected) {
      lines.push({ kind, text, oldLine, newLine });
      if (noNewline) lines.push({ kind: 'note', text: 'Нет перевода строки в конце файла', oldLine: null, newLine: null });
    }
    return { header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, lines };
  });
  return { added, removed, hunks };
}
