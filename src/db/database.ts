import Dexie, { type Table } from 'dexie';
import type { AppStateRecord, ProgressRecord } from '../domain/progress';
import type { BookRecord, CoverCacheRecord } from '../domain/book';

class PDFReaderDatabase extends Dexie {
  books!: Table<BookRecord, string>;
  progress!: Table<ProgressRecord, string>;
  appState!: Table<AppStateRecord, 'singleton'>;
  covers!: Table<CoverCacheRecord, string>;

  constructor() {
    super('pdfreader-p1');

    this.version(1).stores({
      books: 'bookId, canonicalKey, sourceKey, updatedAt, lastOpenedAt, availabilityStatus',
      progress: 'bookId, updatedAt',
      appState: 'key',
      covers: 'bookId, createdAt'
    });
  }
}

export const db = new PDFReaderDatabase();

