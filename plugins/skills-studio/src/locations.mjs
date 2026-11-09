import { spawn } from 'node:child_process';

const failure = (code, message) => Object.assign(new Error(message), { code });

// Paths are passed as arguments or stdin data, never interpreted as shell source.
export function createLocationActions({ platform = process.platform, spawnProcess = spawn, timeoutMs = 10000 } = {}) {
  async function run(command, args, input, message) {
    if (platform !== 'darwin') throw failure('UNSUPPORTED_PLATFORM', 'Копирование пути и открытие Terminal поддерживаются только в macOS.');
    await new Promise((resolve, reject) => {
      let child, timer, finished = false;
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const failed = () => failure('LOCATION_ACTION_FAILED', message);
      try {
        // Discard output to keep native-process output bounded.
        child = spawnProcess(command, args, { shell:false, stdio:[input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] });
        child.once('error', () => finish(failed()));
        child.once('close', (code, signal) => finish(code === 0 && !signal ? undefined : failed()));
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(failure('LOCATION_ACTION_TIMEOUT', message + ' Превышено время ожидания.'));
        }, timeoutMs);
        if (input !== undefined) {
          child.stdin.once('error', () => { child.kill('SIGKILL'); finish(failed()); });
          child.stdin.end(input, 'utf8');
        }
      } catch {
        child?.kill('SIGKILL');
        finish(failed());
      }
    });
  }
  return {
    copyPath: path => run('/usr/bin/pbcopy', [], path, 'Не удалось скопировать путь в буфер обмена.'),
    openTerminal: folder => run('/usr/bin/open', ['-a', 'Terminal', folder], undefined, 'Не удалось открыть папку в Terminal.'),
  };
}

export const { copyPath, openTerminal } = createLocationActions();
