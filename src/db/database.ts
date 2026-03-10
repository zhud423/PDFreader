import Dexie, { type Table } from 'dexie';
import type { AppStateRecord, ProgressRecord } from '../domain/progress';
import type { BookRecord, CoverCacheRecord } from '../domain/book';
import type { SourceInstanceRecord } from '../domain/source';
import type { TitleRecord } from '../domain/title';

class PDFReaderDatabase extends Dexie {
  books!: Table<BookRecord, string>;
  progress!: Table<ProgressRecord, string>;
  appState!: Table<AppStateRecord, 'singleton'>;
  covers!: Table<CoverCacheRecord, string>;
  sources!: Table<SourceInstanceRecord, string>;
  titles!: Table<TitleRecord, string>;

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

    this.version(4)
      .stores({
        books:
          'bookId, titleId, canonicalKey, sourceKey, sourceInstanceId, [sourceInstanceId+sourceKey], updatedAt, lastOpenedAt, availabilityStatus',
        progress: 'bookId, updatedAt',
        appState: 'key',
        covers: 'bookId, createdAt',
        sources: 'sourceInstanceId, sourceType, status, updatedAt',
        titles: 'titleId, updatedAt, lastOpenedAt, displayTitle'
      })
      .upgrade(async (tx) => {
        const titlesTable = tx.table('titles');
        const booksTable = tx.table('books');
        const legacyBooks = (await booksTable.toArray()) as Array<BookRecord & { titleId?: string }>;

        for (const book of legacyBooks) {
          if (book.titleId) {
            continue;
          }

          const titleId = crypto.randomUUID();

          await titlesTable.put({
            titleId,
            title: book.displayTitle,
            displayTitle: book.displayTitle,
            coverBookId: book.coverRef ?? book.bookId,
            lastOpenedAt: book.lastOpenedAt,
            createdAt: book.createdAt,
            updatedAt: book.updatedAt
          });

          await booksTable.put({
            ...book,
            titleId
          });
        }
      });

    this.version(5)
      .stores({
        books:
          'bookId, titleId, contentHash, sourceKey, sourceInstanceId, [sourceInstanceId+sourceKey], updatedAt, lastOpenedAt, availabilityStatus',
        progress: 'bookId, updatedAt',
        appState: 'key',
        covers: 'bookId, createdAt',
        sources: 'sourceInstanceId, sourceType, status, updatedAt',
        titles: 'titleId, updatedAt, lastOpenedAt, displayTitle'
      })
      .upgrade(async (tx) => {
        const booksTable = tx.table('books');
        const legacyBooks = (await booksTable.toArray()) as Array<
          BookRecord & { canonicalKey?: string; contentHash?: string }
        >;

        for (const book of legacyBooks) {
          if (book.contentHash) {
            continue;
          }

          await booksTable.put({
            ...book,
            contentHash: book.canonicalKey ?? ''
          });
        }
      });
  }
}

export const db = new PDFReaderDatabase();
