import { spawn } from 'node:child_process';

function runOsaScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || '目录选择失败。'));
    });
  });
}

export async function chooseFolderPath(prompt = '选择要共享的书库文件夹'): Promise<string | null> {
  if (process.platform !== 'darwin') {
    throw new Error('当前目录选择器仅支持 macOS。');
  }

  try {
    const result = await runOsaScript(`POSIX path of (choose folder with prompt "${prompt.replace(/"/g, '\\"')}")`);
    return result.trim() || null;
  } catch (error) {
    const message = error instanceof Error ? error.message : '目录选择失败。';
    if (message.includes('User canceled') || message.includes('(-128)')) {
      return null;
    }

    throw error;
  }
}
