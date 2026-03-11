export interface FolderRecord {
  id: string;
  path: string;
  name: string;
  addedAt: string;
}

export interface LibraryEntryRecord {
  id: string;
  folderId: string;
  filePath: string;
  relativePath: string;
  fileName: string;
  title: string;
  contentHash: string;
  fileSize: number;
  mimeType: string;
  pageCount: number;
  firstPageWidth: number;
  firstPageHeight: number;
  coverAssetName?: string;
  coverGeneratedAt?: string;
  coverSourceModifiedAt?: string;
  coverPipelineVersion?: number;
  modifiedAt: string;
  scanKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScanIssueRecord {
  filePath: string;
  reason: string;
}

export interface HelperState {
  version: 1;
  sourceName: string;
  appBaseUrl?: string;
  sharingEnabled: boolean;
  folders: FolderRecord[];
  library: LibraryEntryRecord[];
  scanStatus: 'idle' | 'scanning' | 'error';
  scanIssues: ScanIssueRecord[];
  lastScanStartedAt?: string;
  lastScanFinishedAt?: string;
  lastScanDurationMs?: number;
  lastScanError?: string;
}

export interface ScanResult {
  library: LibraryEntryRecord[];
  scanIssues: ScanIssueRecord[];
  scannedFileCount: number;
  reusedFileCount: number;
}

export interface LanUrlRecord {
  label: string;
  address: string;
  sourceBaseUrl: string;
  connectUrl: string;
}

export interface HelperSnapshot {
  state: HelperState;
  summary: {
    bookCount: number;
    folderCount: number;
    issueCount: number;
  };
  urls: {
    manageUrl: string;
    sourceBaseUrl: string;
    connectUrl: string;
    appBaseUrl?: string;
    addRemoteUrl?: string;
    primarySetupUrl: string;
    primarySetupLabel: string;
    lan: LanUrlRecord[];
  };
}
