import { spawn } from 'node:child_process';

function runAppleScript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || '打开浏览器失败。'));
    });
  });
}

export async function openUrlInBrowser(url: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }

  await runAppleScript(`open location "${url.replace(/"/g, '\\"')}"`);
}
