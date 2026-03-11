import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { HelperState } from './types.ts';

const STATE_FILE_NAME = 'state.json';

function buildInitialState(): HelperState {
  return {
    version: 1,
    sourceName: `${os.hostname()} 的 PDFreader 书源`,
    appBaseUrl: process.env.PDFREADER_HELPER_APP_URL?.trim() || undefined,
    sharingEnabled: false,
    folders: [],
    library: [],
    scanStatus: 'idle',
    scanIssues: [],
    lastScanStartedAt: undefined,
    lastScanFinishedAt: undefined,
    lastScanDurationMs: undefined,
    lastScanError: undefined
  };
}

export function resolveDefaultDataDir(): string {
  const override = process.env.PDFREADER_HELPER_DATA_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'PDFreaderHelper');
  }

  return path.join(os.homedir(), '.pdfreader-helper');
}

export class HelperStateStore {
  readonly dataDir: string;
  readonly stateFilePath: string;

  constructor(dataDir = resolveDefaultDataDir()) {
    this.dataDir = path.resolve(dataDir);
    this.stateFilePath = path.join(this.dataDir, STATE_FILE_NAME);
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });

    try {
      await readFile(this.stateFilePath, 'utf8');
    } catch {
      await writeFile(this.stateFilePath, `${JSON.stringify(buildInitialState(), null, 2)}\n`, 'utf8');
    }
  }

  async read(): Promise<HelperState> {
    await this.ensureReady();
    const raw = await readFile(this.stateFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<HelperState>;

    return {
      ...buildInitialState(),
      ...parsed,
      version: 1,
      sourceName: typeof parsed.sourceName === 'string' && parsed.sourceName.trim() ? parsed.sourceName.trim() : buildInitialState().sourceName,
      appBaseUrl:
        typeof parsed.appBaseUrl === 'string' && parsed.appBaseUrl.trim() ? parsed.appBaseUrl.trim() : buildInitialState().appBaseUrl,
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      library: Array.isArray(parsed.library) ? parsed.library : [],
      scanStatus:
        parsed.scanStatus === 'scanning' || parsed.scanStatus === 'error' || parsed.scanStatus === 'idle'
          ? parsed.scanStatus
          : 'idle',
      scanIssues: Array.isArray(parsed.scanIssues) ? parsed.scanIssues : []
    };
  }

  async write(state: HelperState): Promise<void> {
    await this.ensureReady();
    const tempFilePath = path.join(this.dataDir, `${STATE_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tempFilePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempFilePath, this.stateFilePath);
  }

  async mutate(mutateState: (state: HelperState) => HelperState | Promise<HelperState>): Promise<HelperState> {
    const current = await this.read();
    const next = await mutateState(current);
    await this.write(next);
    return next;
  }
}
