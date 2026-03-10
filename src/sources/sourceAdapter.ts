import type { BookRecord } from '../domain/book';
import type {
  AvailabilityStatus,
  SourceInstanceRecord,
  SourceType,
  SourceValidationStatus
} from '../domain/source';

export interface AvailabilitySnapshot {
  status: AvailabilityStatus;
  reason?: string;
}

export type DocumentSourceHandle =
  | {
      kind: 'data';
      data: ArrayBuffer;
    }
  | {
      kind: 'url';
      url: string;
    };

export interface SourceAdapterContext {
  sourceInstance?: SourceInstanceRecord;
}

export interface SourceValidationResult {
  status: SourceValidationStatus;
  reason?: string;
  sourceName?: string;
  bookCount?: number;
}

export interface SourceCatalogBook {
  sourceKey: string;
  contentHash: string;
  title: string;
  displayTitle: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  pageCount: number;
  firstPageWidth: number;
  firstPageHeight: number;
  coverUrl?: string;
  updatedAt?: string;
}

export interface SourceAdapter {
  readonly type: SourceType;
  open(book: BookRecord, context?: SourceAdapterContext): Promise<DocumentSourceHandle>;
  revalidate(book: BookRecord, context?: SourceAdapterContext): Promise<AvailabilitySnapshot>;
  validateSource?(source: SourceInstanceRecord): Promise<SourceValidationResult>;
  listBooks?(source: SourceInstanceRecord): Promise<SourceCatalogBook[]>;
}
