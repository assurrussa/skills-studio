import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const browser = await build({ entryPoints: ['ui/app.mjs'], bundle: true, platform: 'browser', format: 'iife', target: ['chrome120', 'safari17'], minify: true, write: false, legalComments: 'inline' });
const html = await readFile('ui/index.html', 'utf8');
const css = await readFile('ui/style.css', 'utf8');
await mkdir('assets', { recursive: true });
await writeFile('assets/app.html', html.replace('/*__STYLE__*/', () => css).replace('/*__SCRIPT__*/', () => browser.outputFiles[0].text.replaceAll('</script', '<\\/script')));
await build({ entryPoints: ['src/server.mjs'], outfile: 'server.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node20', legalComments: 'inline', banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
console.log('Built server.mjs and assets/app.html (no runtime npm dependencies).');
