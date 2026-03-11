import path from 'node:path';
import { mkdir, rm, symlink, writeFile, cp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
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

      reject(new Error(stderr.trim() || `${command} 执行失败。`));
    });
  });
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('当前 DMG 打包脚本只支持 macOS。');
  }

  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(helperDir, '..');
  const distDir = path.join(repoRoot, 'helper', 'dist');
  const appPath = path.join(distDir, 'PDFreader Helper.app');
  const dmgPath = path.join(distDir, 'PDFreader Helper.dmg');
  const stagingDir = path.join(distDir, '.dmg-root');

  await runCommand(process.execPath, ['--experimental-strip-types', path.join(helperDir, 'buildMacLauncher.ts')], {
    cwd: repoRoot
  });

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  await cp(appPath, path.join(stagingDir, 'PDFreader Helper.app'), {
    recursive: true,
    force: true
  });
  await symlink('/Applications', path.join(stagingDir, 'Applications')).catch(() => undefined);
  await writeFile(
    path.join(stagingDir, 'README.txt'),
    [
      'PDFreader Helper（unsigned build）',
      '',
      '1. 把 PDFreader Helper.app 拖到 Applications 或任意目录。',
      '2. 首次打开若被 macOS 拦截，请先看同目录里的“首次打开失败怎么办.txt”。',
      '3. 打开后选择要共享的文件夹，并点击“开始共享”。',
      '4. 如果浏览器没有自动打开管理页，可手动访问 http://127.0.0.1:48321/manage 。',
      '5. 若手机端提示 Load failed，请先在管理页安装 helper 证书后再重试。'
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    path.join(stagingDir, '首次打开失败怎么办.txt'),
    [
      '如果你双击 PDFreader Helper.app 后，被 macOS 拦截：',
      '',
      '方法 A：',
      '1. 在 Finder 中找到 PDFreader Helper.app。',
      '2. 右键应用，选择“打开”。',
      '3. 在弹窗里再次选择“打开”。',
      '',
      '方法 B：',
      '1. 先尝试双击一次，让系统出现拦截提示。',
      '2. 打开“系统设置 > 隐私与安全性”。',
      '3. 在页面底部找到 PDFreader Helper 被阻止的提示。',
      '4. 点击“仍要打开”，然后再重新启动应用。',
      '',
      '如果应用已经能启动，但管理页没有自动出现：',
      '- 可手动访问 http://127.0.0.1:48321/manage',
      '- 或查看 ~/Library/Application Support/PDFreaderHelper/helper.log',
      '',
      '如果手机端同步提示 Load failed：',
      '- 先在管理页里点击“安装 helper 证书”',
      '- 安装后再回到 PDFreader 重试同步'
    ].join('\n'),
    'utf8'
  );

  await rm(dmgPath, { force: true });
  await runCommand('hdiutil', [
    'create',
    '-volname',
    'PDFreader Helper',
    '-srcfolder',
    stagingDir,
    '-format',
    'UDZO',
    '-ov',
    dmgPath
  ]);

  console.log(dmgPath);
}

void main();
