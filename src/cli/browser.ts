import { type SpawnOptions, spawn } from 'node:child_process';

export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; options: SpawnOptions } {
  if (platform === 'darwin') return { command: 'open', args: [url], options: {} };
  if (platform === 'win32') {
    // `start` treats the first quoted argument as a window title, hence "".
    return {
      command: 'cmd',
      args: ['/c', 'start', '""', `"${url.replaceAll('"', '%22')}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { command: 'xdg-open', args: [url], options: {} };
}

/** Best effort: failures only print a hint. */
export function openBrowser(url: string, onFail: () => void): void {
  const { command, args, options } = browserCommand(url);
  try {
    const child = spawn(command, args, { ...options, stdio: 'ignore', detached: true });
    child.once('error', onFail);
    child.once('exit', (code) => {
      if (code !== 0) onFail();
    });
    child.unref();
  } catch {
    onFail();
  }
}
