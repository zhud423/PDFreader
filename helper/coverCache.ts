import path from 'node:path';
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import type { LibraryEntryRecord } from './types.ts';

const QUICKLOOK_MAX_EDGE = 1600;
const COVER_TARGET_WIDTH = 720;
const COVER_TARGET_HEIGHT = 960;
const MIN_ACCEPTABLE_COVER_WIDTH = 320;
const LONG_PAGE_RATIO_THRESHOLD = 2;
const ALWAYS_USE_HI_RES_COVER = true;
const COVER_PIPELINE_VERSION = 3;

function nowIso(): string {
  return new Date().toISOString();
}

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
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
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || `${command} 执行失败。`));
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function readImageDimensions(filePath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await runCommand('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath]);
  const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
  const width = Number(widthMatch?.[1] ?? 0);
  const height = Number(heightMatch?.[1] ?? 0);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('无法读取封面尺寸。');
  }

  return { width, height };
}

async function generateQuickLookThumbnail(filePath: string, outputDir: string): Promise<string> {
  await ensureDir(outputDir);
  await runCommand('qlmanage', ['-t', '-s', String(QUICKLOOK_MAX_EDGE), '-o', outputDir, filePath]);

  const outputPath = path.join(outputDir, `${path.basename(filePath)}.png`);
  if (!(await fileExists(outputPath))) {
    throw new Error('Quick Look 没有生成缩略图。');
  }

  return outputPath;
}

async function generateHiResCover(filePath: string, outputPath: string, pageRatio: number): Promise<void> {
  const renderPath = `${outputPath}.render.png`;
  const renderByWidth = pageRatio >= COVER_TARGET_HEIGHT / COVER_TARGET_WIDTH;
  const renderArgs = renderByWidth
    ? ['--resampleWidth', String(COVER_TARGET_WIDTH), '-s', 'format', 'png', filePath, '--out', renderPath]
    : ['--resampleHeight', String(COVER_TARGET_HEIGHT), '-s', 'format', 'png', filePath, '--out', renderPath];

  try {
    await runCommand('sips', renderArgs);
    await runCommand('sips', ['-c', String(COVER_TARGET_HEIGHT), String(COVER_TARGET_WIDTH), renderPath, '--out', outputPath]);
  } finally {
    await rm(renderPath, { force: true });
  }
}

export async function syncCoverCache(
  coverDir: string,
  entries: LibraryEntryRecord[],
  previousEntries: LibraryEntryRecord[]
): Promise<LibraryEntryRecord[]> {
  await ensureDir(coverDir);
  const previousById = new Map(previousEntries.map((entry) => [entry.id, entry]));
  const nextIds = new Set(entries.map((entry) => entry.id));
  const tempDir = path.join(coverDir, '.tmp');
  await ensureDir(tempDir);

  const nextEntries: LibraryEntryRecord[] = [];

  for (const entry of entries) {
    const previous = previousById.get(entry.id);
    const assetName = `${entry.id}.png`;
    const assetPath = path.join(coverDir, assetName);
    const canReuse =
      previous?.coverAssetName === assetName &&
      previous.coverSourceModifiedAt === entry.modifiedAt &&
      previous.coverPipelineVersion === COVER_PIPELINE_VERSION &&
      (await fileExists(assetPath));

    if (canReuse) {
      nextEntries.push({
        ...entry,
        coverAssetName: assetName,
        coverGeneratedAt: previous.coverGeneratedAt,
        coverSourceModifiedAt: previous.coverSourceModifiedAt,
        coverPipelineVersion: COVER_PIPELINE_VERSION
      });
      continue;
    }

    try {
      const pageRatio = entry.firstPageHeight / Math.max(1, entry.firstPageWidth);
      const forceHiRes = ALWAYS_USE_HI_RES_COVER || pageRatio >= LONG_PAGE_RATIO_THRESHOLD;
      let tempOutputPath: string;

      if (forceHiRes) {
        tempOutputPath = path.join(tempDir, assetName);
        await generateHiResCover(entry.filePath, tempOutputPath, pageRatio);
      } else {
        tempOutputPath = await generateQuickLookThumbnail(entry.filePath, tempDir);
        const dimensions = await readImageDimensions(tempOutputPath);

        if (dimensions.width < MIN_ACCEPTABLE_COVER_WIDTH) {
          await rm(tempOutputPath, { force: true });
          tempOutputPath = path.join(tempDir, assetName);
          await generateHiResCover(entry.filePath, tempOutputPath, pageRatio);
        }
      }

      await rename(tempOutputPath, assetPath);
      nextEntries.push({
        ...entry,
        coverAssetName: assetName,
        coverGeneratedAt: nowIso(),
        coverSourceModifiedAt: entry.modifiedAt,
        coverPipelineVersion: COVER_PIPELINE_VERSION
      });
    } catch {
      nextEntries.push({
        ...entry,
        coverAssetName: undefined,
        coverGeneratedAt: undefined,
        coverSourceModifiedAt: undefined,
        coverPipelineVersion: undefined
      });
    }
  }

  const assetNames = await readdir(coverDir).catch(() => []);
  await Promise.all(
    assetNames.map(async (name) => {
      if (name === '.tmp') {
        return;
      }

      const entryId = name.replace(/\.png$/i, '');
      if (nextIds.has(entryId)) {
        return;
      }

      await rm(path.join(coverDir, name), { force: true });
    })
  );

  return nextEntries;
}
