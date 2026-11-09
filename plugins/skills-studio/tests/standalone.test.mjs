import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('standalone server runs without node_modules when launched through a symlink', async t => {
  const root = await mkdtemp(join(tmpdir(),'skills-studio-standalone-'));
  await mkdir(join(root,'runtime/assets'),{recursive:true});
  await copyFile(new URL('../server.mjs',import.meta.url),join(root,'runtime/server.mjs'));
  await copyFile(new URL('../assets/app.html',import.meta.url),join(root,'runtime/assets/app.html'));
  await symlink(join(root,'runtime'),join(root,'alias'));
  const client = new Client({name:'standalone-test',version:'1'});
  t.after(async()=>{await client.close();await rm(root,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'alias/server.mjs')]}));
  const {tools}=await client.listTools();
  assert.ok(tools.some(tool=>tool.name==='skills_studio.open'));
  const resource=await client.readResource({uri:'ui://skills-studio/editor'});
  assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app');
});
