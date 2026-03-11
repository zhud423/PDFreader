import path from 'node:path';
import { opendir, realpath, stat } from 'node:fs/promises';
import crypto from 'node:crypto';
import { inspectPdfPath } from './pdfInspector.ts';
import type { FolderRecord, LibraryEntryRecord, ScanIssueRecord, ScanResult } from './types.ts';

function nowIso(): string {
  return new Date().toISOString();
}

function createScanKey(size: number, modifiedAtMs: number): string {
  return `${size}:${Math.round(modifiedAtMs)}`;
}

async function* walkPdfFiles(rootDir: string, baseDir = rootDir): AsyncGenerator<{ filePath: string; relativePath: string }> {
  const dir = await opendir(rootDir);

  for await (const entry of dir) {
    const resolvedPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      yield* walkPdfFiles(resolvedPath, baseDir);
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pdf')) {
      continue;
    }

    yield {
      filePath: resolvedPath,
      relativePath: path.relative(baseDir, resolvedPath)
    };
  }
}

function sortLibrary(entries: LibraryEntryRecord[]): LibraryEntryRecord[] {
  return [...entries].sort((left, right) => {
    const titleCompare = left.title.localeCompare(right.title, 'zh-Hans-CN');
    if (titleCompare !== 0) {
      return titleCompare;
    }

    return left.relativePath.localeCompare(right.relativePath, 'zh-Hans-CN');
  });
}

function pickStableId(
  filePath: string,
  inspection: { contentHash: string },
  previousByPath: Map<string, LibraryEntryRecord>,
  previousByHash: Map<string, LibraryEntryRecord>,
  usedIds: Set<string>
): string {
  const preferred = previousByPath.get(filePath)?.id ?? previousByHash.get(inspection.contentHash)?.id;
  if (preferred && !usedIds.has(preferred)) {
    return preferred;
  }

  let candidate = crypto.randomUUID();
  while (usedIds.has(candidate)) {
    candidate = crypto.randomUUID();
  }

  return candidate;
}

export async function normalizeFolderPath(inputPath: string): Promise<string> {
  const candidate = path.resolve(inputPath.trim());
  const [real, info] = await Promise.all([realpath(candidate), stat(candidate)]);

  if (!info.isDirectory()) {
    throw new Error('目标路径不是文件夹。');
  }

  return real;
}

export async function scanFolders(
  folders: FolderRecord[],
  previousLibrary: LibraryEntryRecord[]
): Promise<ScanResult> {
  const previousByPath = new Map(previousLibrary.map((entry) => [entry.filePath, entry]));
  const previousByHash = new Map(previousLibrary.map((entry) => [entry.contentHash, entry]));
  const scanIssues: ScanIssueRecord[] = [];
  const nextLibrary: LibraryEntryRecord[] = [];
  const usedIds = new Set<string>();
  let scannedFileCount = 0;
  let reusedFileCount = 0;

  for (const folder of folders) {
    try {
      for await (const candidate of walkPdfFiles(folder.path)) {
        scannedFileCount += 1;

        try {
          const fileStats = await stat(candidate.filePath);
          const scanKey = createScanKey(fileStats.size, fileStats.mtimeMs);
          const previous = previousByPath.get(candidate.filePath);
          if (previous && previous.scanKey === scanKey) {
            reusedFileCount += 1;
            usedIds.add(previous.id);
            nextLibrary.push(previous);
            continue;
          }

          const inspected = await inspectPdfPath(candidate.filePath);
          const stableId = pickStableId(candidate.filePath, inspected, previousByPath, previousByHash, usedIds);
          const timestamp = nowIso();
          const previousByStableId = previousLibrary.find((entry) => entry.id === stableId);
          usedIds.add(stableId);

          nextLibrary.push({
            id: stableId,
            folderId: folder.id,
            filePath: candidate.filePath,
            relativePath: candidate.relativePath,
            fileName: path.basename(candidate.filePath),
            title: inspected.title,
            contentHash: inspected.contentHash,
            fileSize: inspected.fileSize,
            mimeType: inspected.mimeType,
            pageCount: inspected.pageCount,
            firstPageWidth: inspected.firstPageWidth,
            firstPageHeight: inspected.firstPageHeight,
            modifiedAt: inspected.modifiedAt,
            scanKey,
            createdAt: previousByStableId?.createdAt ?? timestamp,
            updatedAt: timestamp
          });
        } catch (error) {
          scanIssues.push({
            filePath: candidate.filePath,
            reason: error instanceof Error ? error.message : '扫描失败'
          });
        }
      }
    } catch (error) {
      scanIssues.push({
        filePath: folder.path,
        reason: error instanceof Error ? error.message : '文件夹扫描失败'
      });
    }
  }

  return {
    library: sortLibrary(nextLibrary),
    scanIssues,
    scannedFileCount,
    reusedFileCount
  };
}
