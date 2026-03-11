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

interface HelperTlsStatus {
  enabled: boolean;
  port?: number;
  caCertPath?: string;
  caCerPath?: string;
}

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

function extractUrlProtocol(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).protocol;
  } catch {
    return null;
  }
}

function canBuildAppAddUrl(appBaseUrl: string, sourceBaseUrl: string): boolean {
  const appProtocol = extractUrlProtocol(appBaseUrl);
  const sourceProtocol = extractUrlProtocol(sourceBaseUrl);
  if (appProtocol === 'https:' && sourceProtocol === 'http:') {
    return false;
  }
  return true;
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
  readonly tlsPort: number;
  readonly coverDir: string;
  private tlsStatus: HelperTlsStatus;
  private currentScan: Promise<HelperState> | null = null;

  constructor(options?: { dataDir?: string; port?: number; tlsPort?: number }) {
    this.store = new HelperStateStore(options?.dataDir);
    this.port = options?.port ?? 48321;
    this.tlsPort = options?.tlsPort ?? this.port + 1;
    this.coverDir = path.join(this.store.dataDir, 'covers');
    this.tlsStatus = {
      enabled: false
    };
  }

  async initialize(): Promise<void> {
    await this.store.ensureReady();
  }

  async getState(): Promise<HelperState> {
    return this.store.read();
  }

  async getSnapshot(): Promise<HelperSnapshot> {
    const state = await this.getState();
    const lanHttp = listLanUrls(this.port, 'http');
    const localhostHttp = `http://127.0.0.1:${this.port}`;
    const sourceBaseUrlHttp = lanHttp[0]?.sourceBaseUrl ?? `${localhostHttp}/source`;
    const connectUrlHttp = lanHttp[0]?.connectUrl ?? `${localhostHttp}/connect`;

    const tlsEnabled = Boolean(this.tlsStatus.enabled && this.tlsStatus.port && this.tlsStatus.caCertPath);
    const lanHttps = tlsEnabled ? listLanUrls(this.tlsStatus.port ?? this.tlsPort, 'https') : [];
    const localhostHttps = `https://127.0.0.1:${this.tlsStatus.port ?? this.tlsPort}`;
    const sourceBaseUrlHttps = tlsEnabled ? lanHttps[0]?.sourceBaseUrl ?? `${localhostHttps}/source` : undefined;
    const connectUrlHttps = tlsEnabled ? lanHttps[0]?.connectUrl ?? `${localhostHttps}/connect` : undefined;

    const sourceBaseUrl = sourceBaseUrlHttps ?? sourceBaseUrlHttp;
    const connectUrl = connectUrlHttp;
    const effectiveAppBaseUrl = inferDefaultAppBaseUrl(lanHttps.length > 0 ? lanHttps : lanHttp) ?? state.appBaseUrl;
    let addRemoteUrl: string | undefined;
    if (effectiveAppBaseUrl && canBuildAppAddUrl(effectiveAppBaseUrl, sourceBaseUrl)) {
      try {
        addRemoteUrl = this.buildAppAddUrl(effectiveAppBaseUrl, sourceBaseUrl, state.sourceName);
      } catch {
        addRemoteUrl = undefined;
      }
    }
    const primarySetupUrl = addRemoteUrl ?? connectUrl;
    const primarySetupLabel = addRemoteUrl ? '直接打开 PDFreader 添加页' : '先打开连接页';
    const certificateInstallUrl = tlsEnabled
      ? lanHttp[0]
        ? `http://${lanHttp[0].address}:${this.port}/certs/helper-ca.cer`
        : `${localhostHttp}/certs/helper-ca.cer`
      : undefined;

    return {
      state,
      summary: {
        bookCount: state.library.length,
        folderCount: state.folders.length,
        issueCount: state.scanIssues.length
      },
      urls: {
        manageUrl: `${localhostHttp}/manage`,
        sourceBaseUrl,
        connectUrl,
        sourceBaseUrlHttp,
        sourceBaseUrlHttps,
        connectUrlHttp,
        connectUrlHttps,
        certificateInstallUrl,
        tlsEnabled,
        tlsPort: this.tlsStatus.port,
        appBaseUrl: effectiveAppBaseUrl,
        addRemoteUrl,
        primarySetupUrl,
        primarySetupLabel,
        lan: lanHttps.length > 0 ? lanHttps : lanHttp
      }
    };
  }

  setTlsStatus(status: HelperTlsStatus): void {
    this.tlsStatus = {
      enabled: Boolean(status.enabled),
      port: status.port,
      caCertPath: status.caCertPath,
      caCerPath: status.caCerPath
    };
  }

  getTlsCaCertPath(): string | undefined {
    return this.tlsStatus.caCertPath;
  }

  getTlsCaCerPath(): string | undefined {
    return this.tlsStatus.caCerPath;
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
          coverPath: entry.coverAssetName
            ? `./covers/${entry.coverAssetName}?v=${encodeURIComponent(entry.coverGeneratedAt ?? entry.modifiedAt)}`
            : undefined,
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
    sourceBaseUrlHttp?: string;
    sourceBaseUrlHttps?: string;
    connectUrl: string;
    connectUrlHttp?: string;
    connectUrlHttps?: string;
    certificateInstallUrl?: string;
    tlsEnabled?: boolean;
    tlsPort?: number;
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
      sourceBaseUrlHttp: snapshot.urls.sourceBaseUrlHttp,
      sourceBaseUrlHttps: snapshot.urls.sourceBaseUrlHttps,
      connectUrl: snapshot.urls.connectUrl,
      connectUrlHttp: snapshot.urls.connectUrlHttp,
      connectUrlHttps: snapshot.urls.connectUrlHttps,
      certificateInstallUrl: snapshot.urls.certificateInstallUrl,
      tlsEnabled: snapshot.urls.tlsEnabled,
      tlsPort: snapshot.urls.tlsPort,
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
    const lan = this.tlsStatus.enabled ? listLanUrls(this.tlsStatus.port ?? this.tlsPort, 'https') : listLanUrls(this.port);
    const headline = `PDFreader Helper 已启动`;
    const sourceUrl = lan[0]?.sourceBaseUrl ?? (this.tlsStatus.enabled ? `https://127.0.0.1:${this.tlsStatus.port ?? this.tlsPort}/source` : `http://127.0.0.1:${this.port}/source`);
    const manageUrl = `http://127.0.0.1:${this.port}/manage`;
    const lines = [headline, `管理页：${manageUrl}`, `书源地址：${sourceUrl}`, `主机：${os.hostname()}`];
    if (this.tlsStatus.enabled && this.tlsStatus.port) {
      lines.push(`HTTPS 端口：${this.tlsStatus.port}`);
      lines.push(`证书下载：http://127.0.0.1:${this.port}/certs/helper-ca.cer`);
    }
    return lines.join('\n');
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
