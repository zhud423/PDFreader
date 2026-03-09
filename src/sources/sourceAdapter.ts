import type { BookRecord } from '../domain/book';
import type { AvailabilityStatus, SourceType } from '../domain/source';

export interface AvailabilitySnapshot {
  status: AvailabilityStatus;
  reason?: string;
}

export interface DocumentSourceHandle {
  data: ArrayBuffer;
}

export interface SourceAdapter {
  readonly type: SourceType;
  open(book: BookRecord): Promise<DocumentSourceHandle>;
  revalidate(book: BookRecord): Promise<AvailabilitySnapshot>;
}

