import path from 'node:path';
import { chmod, copyFile, cp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'PDFreader Helper.app';
const EXECUTABLE_NAME = 'PDFreader Helper';
const BUNDLE_ID = 'com.pdfreader.helper';

async function ensureExecutable(filePath: string): Promise<void> {
  await chmod(filePath, 0o755);
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `${command} 执行失败。`));
    });
  });
}

function shouldSkipHelperPath(relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }

  if (relativePath === 'README.md' || relativePath === 'buildMacLauncher.ts') {
    return true;
  }

  return relativePath.split(path.sep)[0] === 'dist';
}

async function copyHelperRuntime(helperDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const stack = [''];

  while (stack.length > 0) {
    const relativeDir = stack.pop() ?? '';
    const sourceDir = path.join(helperDir, relativeDir);
    const destinationDir = path.join(targetDir, relativeDir);
    await mkdir(destinationDir, { recursive: true });

    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      if (shouldSkipHelperPath(relativePath)) {
        continue;
      }

      const sourcePath = path.join(helperDir, relativePath);
      const destinationPath = path.join(targetDir, relativePath);
      if (entry.isDirectory()) {
        stack.push(relativePath);
        continue;
      }

      if (entry.isFile()) {
        await copyFile(sourcePath, destinationPath);
      }
    }
  }
}

async function copyPackage(sourceRoot: string, destinationRoot: string, packageName: string): Promise<void> {
  const sourcePath = path.join(sourceRoot, packageName);
  const destinationPath = path.join(destinationRoot, packageName);
  await cp(sourcePath, destinationPath, {
    recursive: true,
    force: true
  });
}

async function assertUniversalNodeBinary(nodePath: string): Promise<void> {
  const archs = await runCommand('lipo', ['-archs', nodePath]).catch(async () => {
    const fileOutput = await runCommand('file', [nodePath]);
    return fileOutput;
  });

  const hasX64 = /\bx86_64\b/.test(archs);
  const hasArm64 = /\barm64\b/.test(archs);
  if (!hasX64 || !hasArm64) {
    throw new Error('当前 Node 不是同时包含 x86_64 和 arm64 的 universal binary，无法产出通用 Mac helper 包。');
  }
}

function buildInfoPlist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>PDFreader Helper</string>
  <key>CFBundleExecutable</key>
  <string>${EXECUTABLE_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>PDFreader Helper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function buildLauncherScript(): string {
  return `#!/bin/sh
set -eu

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:\${PATH:-}"

CONTENTS_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
APP_ROOT="$RESOURCES_DIR/app"
NODE_BIN="$RESOURCES_DIR/runtime/bin/node"
SERVER_SCRIPT="$APP_ROOT/helper/server.ts"
PORT="\${PDFREADER_HELPER_PORT:-48321}"
DATA_DIR="\${PDFREADER_HELPER_DATA_DIR:-$HOME/Library/Application Support/PDFreaderHelper}"
LOG_PATH="$DATA_DIR/helper.log"
API_URL="http://127.0.0.1:$PORT/api/state"
MANAGE_URL="http://127.0.0.1:$PORT/manage"
OPEN_BROWSER="\${PDFREADER_HELPER_OPEN_BROWSER:-1}"

mkdir -p "$DATA_DIR"

helper_ready() {
  /usr/bin/curl -fsS --max-time 1 "$API_URL" >/dev/null 2>&1
}

if ! helper_ready; then
  (
    cd "$APP_ROOT"
    PDFREADER_HELPER_PORT="$PORT" \\
    PDFREADER_HELPER_DATA_DIR="$DATA_DIR" \\
    PDFREADER_HELPER_OPEN_BROWSER=0 \\
    nohup "$NODE_BIN" --experimental-strip-types "$SERVER_SCRIPT" >>"$LOG_PATH" 2>&1 &
  )

  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if helper_ready; then
      break
    fi

    attempt=$((attempt + 1))
    /bin/sleep 0.5
  done
fi

if ! helper_ready; then
  /usr/bin/osascript -e 'display dialog "PDFreader Helper 没有成功启动。" & return & return & "如果这是第一次打开：" & return & "1. 回到 Finder，右键 PDFreader Helper.app，选择“打开”。" & return & "2. 若系统仍拦截，请到“系统设置 > 隐私与安全性”点击“仍要打开”。" & return & "3. 如果应用已经能启动，但管理页没有出现，请查看 ~/Library/Application Support/PDFreaderHelper/helper.log。" with title "PDFreader Helper 启动失败" buttons {"好"} default button 1 with icon stop'
  exit 1
fi

if [ "$OPEN_BROWSER" != "0" ]; then
  /usr/bin/open "$MANAGE_URL"
fi
`;
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('当前打包脚本只支持 macOS。');
  }

  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(helperDir, '..');
  const outDir = path.join(repoRoot, 'helper', 'dist');
  const appPath = path.join(outDir, APP_NAME);
  const contentsDir = path.join(appPath, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const runtimeDir = path.join(resourcesDir, 'runtime', 'bin');
  const appRuntimeDir = path.join(resourcesDir, 'app');
  const helperRuntimeDir = path.join(appRuntimeDir, 'helper');
  const nodeModulesDir = path.join(appRuntimeDir, 'node_modules');
  const executablePath = path.join(macOsDir, EXECUTABLE_NAME);
  const plistPath = path.join(contentsDir, 'Info.plist');
  const pkgInfoPath = path.join(contentsDir, 'PkgInfo');
  const nodeBinaryPath = path.join(runtimeDir, 'node');
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: string };
  const version = packageJson.version?.trim() || '0.1.0';
  const sourceNodeModulesDir = path.join(repoRoot, 'node_modules');
  const sourceNodeBinary = await realpath(process.execPath);

  await mkdir(outDir, { recursive: true });
  await rm(appPath, { recursive: true, force: true });
  await mkdir(macOsDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(nodeModulesDir, { recursive: true });

  await copyHelperRuntime(helperDir, helperRuntimeDir);
  await writeFile(
    path.join(appRuntimeDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'pdfreader-helper-runtime',
        private: true,
        version,
        type: 'module'
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  for (const packageName of ['pdfjs-dist', 'qrcode', 'dijkstrajs', 'pngjs']) {
    await copyPackage(sourceNodeModulesDir, nodeModulesDir, packageName);
  }
  await assertUniversalNodeBinary(sourceNodeBinary);
  await copyFile(sourceNodeBinary, nodeBinaryPath);
  await ensureExecutable(nodeBinaryPath);

  await writeFile(plistPath, buildInfoPlist(version), 'utf8');
  await writeFile(pkgInfoPath, 'APPL????', 'utf8');
  await writeFile(executablePath, buildLauncherScript(), 'utf8');
  await ensureExecutable(executablePath);

  console.log(appPath);
}

void main();
