import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chooseFolderPath } from './macFolderPicker.ts';
import { listLanUrls } from './network.ts';
import { renderQrSvg } from './qrCode.ts';
import { scanFolders, normalizeFolderPath } from './libraryScanner.ts';
import { HelperStateStore } from './stateStore.ts';
import { syncCoverCache } from './coverCache.ts';
import type { FolderRecord, HelperSnapshot, HelperState, LibraryEntryRecord } from './types.ts';

const DEFAULT_PDFREADER_APP_BASE_URL = 'https://pdfreader.gensstudio.com';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeAppBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('PDFreader App 地址无效。');
  }

  parsed.hash = '';
  parsed.search = '';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function inferDefaultAppBaseUrl(lan: ReturnType<typeof listLanUrls>): string | undefined {
  const fromEnv = process.env.PDFREADER_HELPER_APP_URL?.trim();
  if (fromEnv) {
    try {
      return normalizeAppBaseUrl(fromEnv);
    } catch {
      return undefined;
    }
  }

  if (DEFAULT_PDFREADER_APP_BASE_URL) {
    return DEFAULT_PDFREADER_APP_BASE_URL;
  }

  const appPort = Number(process.env.PDFREADER_APP_PORT ?? 4173);
  const primaryLan = lan[0];
  if (!primaryLan || !Number.isInteger(appPort) || appPort <= 0) {
    return undefined;
  }

  return `http://${primaryLan.address}:${appPort}`;
}

function trimPdfExt(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '').trim();
}

function deriveWorkAndChapter(entry: LibraryEntryRecord): {
  workKey: string;
  workTitle: string;
  chapterTitle: string;
  chapterPath: string;
} {
  const relativePath = entry.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = relativePath.split('/').filter(Boolean);

  if (segments.length <= 1) {
    const rawName = segments[0] ?? entry.fileName;
    const chapterTitle = trimPdfExt(rawName) || entry.title || rawName || '未命名章节';
    const workTitle = chapterTitle || '未命名作品';
    const workKey = `root:${relativePath || entry.id}`;

    return {
      workKey,
      workTitle,
      chapterTitle,
      chapterPath: rawName
    };
  }

  const workTitle = segments[0];
  const chapterPath = segments.slice(1).join('/');
  const chapterTitle = trimPdfExt(chapterPath) || entry.title || entry.fileName;

  return {
    workKey: `folder:${workTitle}`,
    workTitle,
    chapterTitle,
    chapterPath
  };
}

export class HelperService {
  readonly store: HelperStateStore;
  readonly port: number;
  readonly coverDir: string;
  private currentScan: Promise<HelperState> | null = null;

  constructor(options?: { dataDir?: string; port?: number }) {
    this.store = new HelperStateStore(options?.dataDir);
    this.port = options?.port ?? 48321;
    this.coverDir = path.join(this.store.dataDir, 'covers');
  }

  async initialize(): Promise<void> {
    await this.store.ensureReady();
  }

  async getState(): Promise<HelperState> {
    return this.store.read();
  }

  async getSnapshot(): Promise<HelperSnapshot> {
    const state = await this.getState();
    const lan = listLanUrls(this.port);
    const localhost = `http://127.0.0.1:${this.port}`;
    const sourceBaseUrl = lan[0]?.sourceBaseUrl ?? `${localhost}/source`;
    const connectUrl = lan[0]?.connectUrl ?? `${localhost}/connect`;
    const effectiveAppBaseUrl = inferDefaultAppBaseUrl(lan) ?? state.appBaseUrl;
    let addRemoteUrl: string | undefined;
    if (effectiveAppBaseUrl) {
      try {
        addRemoteUrl = this.buildAppAddUrl(effectiveAppBaseUrl, sourceBaseUrl, state.sourceName);
      } catch {
        addRemoteUrl = undefined;
      }
    }
    const primarySetupUrl = addRemoteUrl ?? connectUrl;
    const primarySetupLabel = addRemoteUrl ? '直接打开 PDFreader 添加页' : '先打开连接页';

    return {
      state,
      summary: {
        bookCount: state.library.length,
        folderCount: state.folders.length,
        issueCount: state.scanIssues.length
      },
      urls: {
        manageUrl: `${localhost}/manage`,
        sourceBaseUrl,
        connectUrl,
        appBaseUrl: effectiveAppBaseUrl,
        addRemoteUrl,
        primarySetupUrl,
        primarySetupLabel,
        lan
      }
    };
  }

  async updateSourceName(inputName: string): Promise<HelperState> {
    const nextName = inputName.trim();
    if (!nextName) {
      throw new Error('书源名称不能为空。');
    }

    return this.store.mutate((state) => ({
      ...state,
      sourceName: nextName
    }));
  }

  async updateAppBaseUrl(inputBaseUrl: string): Promise<HelperState> {
    const nextBaseUrl = normalizeAppBaseUrl(inputBaseUrl);

    return this.store.mutate((state) => ({
      ...state,
      appBaseUrl: nextBaseUrl || undefined
    }));
  }

  async addFolderPath(inputPath: string): Promise<FolderRecord> {
    const normalizedPath = await normalizeFolderPath(inputPath);
    const folderName = path.basename(normalizedPath) || normalizedPath;
    let nextFolder: FolderRecord | null = null;

    await this.store.mutate((state) => {
      const existing = state.folders.find((folder) => folder.path === normalizedPath);
      if (existing) {
        nextFolder = existing;
        return state;
      }

      nextFolder = {
        id: crypto.randomUUID(),
        path: normalizedPath,
        name: folderName,
        addedAt: nowIso()
      };

      return {
        ...state,
        folders: [...state.folders, nextFolder]
      };
    });

    if (!nextFolder) {
      throw new Error('添加文件夹失败。');
    }

    const nextState = await this.getState();
    if (nextState.sharingEnabled) {
      await this.rescan();
    }

    return nextFolder;
  }

  async chooseAndAddFolder(): Promise<FolderRecord | null> {
    const selected = await chooseFolderPath();
    if (!selected) {
      return null;
    }

    return this.addFolderPath(selected);
  }

  async removeFolder(folderId: string): Promise<HelperState> {
    return this.store.mutate((state) => ({
      ...state,
      folders: state.folders.filter((folder) => folder.id !== folderId),
      library: state.library.filter((entry) => entry.folderId !== folderId)
    }));
  }

  async startSharing(): Promise<HelperState> {
    await this.store.mutate((state) => ({
      ...state,
      sharingEnabled: true
    }));

    return this.rescan();
  }

  async stopSharing(): Promise<HelperState> {
    return this.store.mutate((state) => ({
      ...state,
      sharingEnabled: false
    }));
  }

  async rescan(): Promise<HelperState> {
    if (this.currentScan) {
      return this.currentScan;
    }

    this.currentScan = this.runScan();

    try {
      return await this.currentScan;
    } finally {
      this.currentScan = null;
    }
  }

  private async runScan(): Promise<HelperState> {
    const startedAt = nowIso();
    await this.store.mutate((state) => ({
      ...state,
      scanStatus: 'scanning',
      lastScanStartedAt: startedAt,
      lastScanError: undefined
    }));

    const currentState = await this.getState();

    try {
      const result = await scanFolders(currentState.folders, currentState.library);
      const libraryWithCovers = await syncCoverCache(this.coverDir, result.library, currentState.library);
      const finishedAt = nowIso();
      const durationMs = Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());

      return this.store.mutate((state) => ({
        ...state,
        library: libraryWithCovers,
        scanIssues: result.scanIssues,
        scanStatus: result.scanIssues.length > 0 ? 'error' : 'idle',
        lastScanStartedAt: startedAt,
        lastScanFinishedAt: finishedAt,
        lastScanDurationMs: durationMs,
        lastScanError: result.scanIssues.length > 0 ? `${result.scanIssues.length} 个文件扫描失败。` : undefined
      }));
    } catch (error) {
      const finishedAt = nowIso();
      const message = error instanceof Error ? error.message : '扫描失败';

      return this.store.mutate((state) => ({
        ...state,
        scanStatus: 'error',
        lastScanStartedAt: startedAt,
        lastScanFinishedAt: finishedAt,
        lastScanDurationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
        lastScanError: message
      }));
    }
  }

  async getLibraryEntryById(id: string): Promise<LibraryEntryRecord | null> {
    const state = await this.getState();
    return state.library.find((entry) => entry.id === id) ?? null;
  }

  async getManifest(): Promise<Record<string, unknown>> {
    const state = await this.getState();

    return {
      version: 1,
      title: state.sourceName,
      generatedAt: nowIso(),
      books: state.library.map((entry) => {
        const derived = deriveWorkAndChapter(entry);

        return {
          id: entry.id,
          title: derived.chapterTitle,
          fileName: entry.fileName,
          contentHash: entry.contentHash,
          fileSize: entry.fileSize,
          mimeType: entry.mimeType,
          pageCount: entry.pageCount,
          firstPageWidth: entry.firstPageWidth,
          firstPageHeight: entry.firstPageHeight,
          pdfPath: `./books/${entry.id}.pdf`,
          coverPath: entry.coverAssetName ? `./covers/${entry.coverAssetName}` : undefined,
          workKey: derived.workKey,
          workTitle: derived.workTitle,
          chapterPath: derived.chapterPath,
          updatedAt: entry.modifiedAt
        };
      })
    };
  }

  async getConsumerState(): Promise<{
    sourceName: string;
    appBaseUrl?: string;
    sharingEnabled: boolean;
    sourceBaseUrl: string;
    connectUrl: string;
    addRemoteUrl?: string;
    primarySetupUrl: string;
    primarySetupLabel: string;
    bookCount: number;
    folderCount: number;
    lan: ReturnType<typeof listLanUrls>;
    lastScanFinishedAt?: string;
    lastScanError?: string;
  }> {
    const snapshot = await this.getSnapshot();

    return {
      sourceName: snapshot.state.sourceName,
      appBaseUrl: snapshot.urls.appBaseUrl,
      sharingEnabled: snapshot.state.sharingEnabled,
      sourceBaseUrl: snapshot.urls.sourceBaseUrl,
      connectUrl: snapshot.urls.connectUrl,
      addRemoteUrl: snapshot.urls.addRemoteUrl,
      primarySetupUrl: snapshot.urls.primarySetupUrl,
      primarySetupLabel: snapshot.urls.primarySetupLabel,
      bookCount: snapshot.summary.bookCount,
      folderCount: snapshot.summary.folderCount,
      lan: snapshot.urls.lan,
      lastScanFinishedAt: snapshot.state.lastScanFinishedAt,
      lastScanError: snapshot.state.lastScanError
    };
  }

  async getQrSvg(target: 'primary' | 'connect' | 'source' | 'add'): Promise<string> {
    const snapshot = await this.getSnapshot();
    const value =
      target === 'primary'
        ? snapshot.urls.primarySetupUrl
        : target === 'connect'
          ? snapshot.urls.connectUrl
          : target === 'source'
            ? snapshot.urls.sourceBaseUrl
            : snapshot.urls.addRemoteUrl;

    if (!value) {
      throw new Error('当前还没有可用的二维码目标。');
    }

    return renderQrSvg(value);
  }

  getServerBanner(): string {
    const lan = listLanUrls(this.port);
    const headline = `PDFreader Helper 已启动`;
    const sourceUrl = lan[0]?.sourceBaseUrl ?? `http://127.0.0.1:${this.port}/source`;
    const manageUrl = `http://127.0.0.1:${this.port}/manage`;

    return [headline, `管理页：${manageUrl}`, `书源地址：${sourceUrl}`, `主机：${os.hostname()}`].join('\n');
  }

  private buildAppAddUrl(appBaseUrl: string, sourceBaseUrl: string, sourceName: string): string {
    const addUrl = new URL('/add', appBaseUrl.endsWith('/') ? appBaseUrl : `${appBaseUrl}/`);
    addUrl.searchParams.set('focus', 'remote');
    addUrl.searchParams.set('auto', '1');
    addUrl.searchParams.set('baseUrl', sourceBaseUrl);
    addUrl.searchParams.set('sourceName', sourceName);
    return addUrl.toString();
  }
}
