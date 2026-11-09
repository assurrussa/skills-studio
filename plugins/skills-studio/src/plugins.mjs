import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

async function directories(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter(x => x.isDirectory() || x.isSymbolicLink()).map(x => x.name); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function pluginSkillRoots(codexHome, warnings, installed = null) {
  const cache = join(codexHome, 'plugins/cache');
  const roots = [];
  try {
    for (const marketplace of await directories(cache)) {
      for (const name of await directories(join(cache, marketplace))) {
        const versions = await directories(join(cache, marketplace, name));
        versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
        if (!versions.length) continue;
        const installation = installed?.find(item => (item.name === name || item.pluginId === `${name}@${marketplace}` || item.pluginId === `${marketplace}/${name}`) && (!item.marketplaceName || item.marketplaceName === marketplace));
        const version = installation?.version || versions[0];
        if (!versions.includes(version)) {
          warnings.push(`Установленная версия плагина ${name} (${version}) отсутствует в кэше.`);
          continue;
        }
        const pluginRoot = resolve(cache, marketplace, name, version);
        let manifest = {};
        for (const filename of ['plugin.json', '.codex-plugin/plugin.json']) {
          try { manifest = JSON.parse(await readFile(join(pluginRoot, filename), 'utf8')); break; }
          catch (error) { if (error.code !== 'ENOENT') warnings.push(`Не удалось прочитать ${join(pluginRoot, filename)}: ${error.message}`); }
        }
        const presentation = manifest.interface || manifest.extensions?.['com.openai']?.interface || manifest.extensions?.com?.openai?.interface;
        const plugin = { id: `${marketplace}/${name}`, name: presentation?.displayName || manifest.name || name, marketplace, version, installed: Boolean(installation), enabled: typeof installation?.enabled === 'boolean' ? installation.enabled : null };
        const paths = manifest.skills === undefined ? ['./skills'] : Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills];
        for (const configuredPath of paths) {
          if (typeof configuredPath !== 'string') continue;
          const path = resolve(pluginRoot, configuredPath);
          if (path !== pluginRoot && !path.startsWith(pluginRoot + sep)) continue;
          const direct = await stat(join(path, 'SKILL.md')).then(info => info.isFile()).catch(() => false);
          roots.push({ path, direct, scope: 'plugin', source: plugin.name, plugin, readOnly: true });
        }
      }
    }
  } catch (error) { warnings.push(`Не удалось прочитать скиллы плагинов: ${error.message}`); }
  return roots;
}
