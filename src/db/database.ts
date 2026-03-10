import Dexie, { type Table } from 'dexie';
import type { AppStateRecord, ProgressRecord } from '../domain/progress';
import type { BookRecord, CoverCacheRecord } from '../domain/book';
import type { SourceInstanceRecord } from '../domain/source';

class PDFReaderDatabase extends Dexie {
  books!: Table<BookRecord, string>;
  progress!: Table<ProgressRecord, string>;
  appState!: Table<AppStateRecord, 'singleton'>;
  covers!: Table<CoverCacheRecord, string>;
  sources!: Table<SourceInstanceRecord, string>;

  constructor() {
    super('pdfreader-p1');

    this.version(1).stores({
      books: 'bookId, canonicalKey, sourceKey, updatedAt, lastOpenedAt, availabilityStatus',
      progress: 'bookId, updatedAt',
      appState: 'key',
      covers: 'bookId, createdAt'
    });

    this.version(2).stores({
      books: 'bookId, canonicalKey, sourceKey, updatedAt, lastOpenedAt, availabilityStatus',
      progress: 'bookId, updatedAt',
      appState: 'key',
      covers: 'bookId, createdAt',
      sources: 'sourceInstanceId, sourceType, status, updatedAt'
    });

    this.version(3).stores({
      books:
        'bookId, canonicalKey, sourceKey, sourceInstanceId, [sourceInstanceId+sourceKey], updatedAt, lastOpenedAt, availabilityStatus',
      progress: 'bookId, updatedAt',
      appState: 'key',
      covers: 'bookId, createdAt',
      sources: 'sourceInstanceId, sourceType, status, updatedAt'
    });
  }
}

export const db = new PDFReaderDatabase();
