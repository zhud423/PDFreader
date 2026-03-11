import type { AvailabilityStatus, SourceType } from './source';
import type { ProgressRecord } from './progress';

export interface BookRecord {
  bookId: string;
  titleId: string;
  contentHash: string;
  sourceType: SourceType;
  sourceInstanceId: string;
  sourceKey: string;
  collectionKey?: string;
  title: string;
  displayTitle: string;
  coverRef?: string | null;
  pageCount: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  contentHashPreview: string;
  firstPageWidth: number;
  firstPageHeight: number;
  availabilityStatus: AvailabilityStatus;
  availabilityReason?: string;
  lastValidatedAt?: string;
  lastOpenedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoverCacheRecord {
  bookId: string;
  blob: Blob;
  width: number;
  height: number;
  createdAt: string;
}

export interface BookWithProgress extends BookRecord {
  progress: ProgressRecord | null;
}
