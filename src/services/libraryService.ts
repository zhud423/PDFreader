import { db } from '../db/database';
import type { BookRecord, BookWithProgress } from '../domain/book';
import type { AppStateRecord, ProgressRecord } from '../domain/progress';
import { emitLibraryChanged } from './libraryEvents';
import { LOCAL_SOURCE_INSTANCE_ID, localUploadSource } from '../sources/localUploadSource';

export interface ImportResult {
  imported: BookRecord[];
  failed: Array<{ fileName: string; reason: string }>;
  updatedExistingCount: number;
}

export interface HomeOverview {
  continueReading: BookWithProgress | null;
  recentBooks: BookWithProgress[];
  availableBooks: BookWithProgress[];
  unavailableBooks: BookWithProgress[];
}

export interface ReaderSession {
  book: BookRecord;
  progress: ProgressRecord | null;
  data: ArrayBuffer | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDefaultProgress(bookId: string): ProgressRecord {
  return {
    bookId,
    pageIndex: 0,
    segmentIndex: 0,
    scrollOffsetWithinSegment: 0,
    zoomScale: 1,
    viewportWidth: 0,
    viewportHeight: 0,
    restoreStrategyVersion: 1,
    updatedAt: nowIso()
  };
}

function normalizeBookRecord(existing: BookRecord | undefined, params: Omit<BookRecord, 'createdAt' | 'updatedAt'>): BookRecord {
  const timestamp = nowIso();
  return {
    ...params,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

async function listBooksWithProgress(): Promise<BookWithProgress[]> {
  const [books, progress] = await Promise.all([
    db.books.orderBy('updatedAt').reverse().toArray(),
    db.progress.toArray()
  ]);
  const progressMap = new Map(progress.map((entry) => [entry.bookId, entry]));

  return books.map((book) => ({
    ...book,
    progress: progressMap.get(book.bookId) ?? null
  }));
}

async function getSingletonAppState(): Promise<AppStateRecord> {
  const existing = await db.appState.get('singleton');
  if (existing) {
    return existing;
  }

  const created: AppStateRecord = {
    key: 'singleton',
    lastUsedAt: nowIso()
  };
  await db.appState.put(created);
  return created;
}

export const libraryService = {
  async getHomeOverview(): Promise<HomeOverview> {
    const [books, appState] = await Promise.all([listBooksWithProgress(), getSingletonAppState()]);
    const continueReading =
      books.find((book) => book.bookId === appState.lastOpenedBookId) ?? books.at(0) ?? null;
    const availableBooks = books.filter((book) => book.availabilityStatus === 'available');
    const unavailableBooks = books.filter((book) => book.availabilityStatus !== 'available');

    return {
      continueReading,
      recentBooks: books,
      availableBooks,
      unavailableBooks
    };
  },

  async getBook(bookId: string): Promise<BookRecord | undefined> {
    return db.books.get(bookId);
  },

  async getBookWithProgress(bookId: string): Promise<BookWithProgress | null> {
    const [book, progress] = await Promise.all([db.books.get(bookId), db.progress.get(bookId)]);

    if (!book) {
      return null;
    }

    return {
      ...book,
      progress: progress ?? null
    };
  },

  async getReaderSession(bookId: string): Promise<ReaderSession | null> {
    const book = await db.books.get(bookId);

    if (!book) {
      return null;
    }

    const progress = (await db.progress.get(bookId)) ?? null;
    const availability = await localUploadSource.revalidate(book);
    const nextBook =
      availability.status === book.availabilityStatus && availability.reason === book.availabilityReason
        ? book
        : {
            ...book,
            availabilityStatus: availability.status,
            availabilityReason: availability.reason,
            lastValidatedAt: nowIso(),
            updatedAt: nowIso()
          };

    if (nextBook !== book) {
      await db.books.put(nextBook);
      emitLibraryChanged();
    }

    if (nextBook.availabilityStatus !== 'available') {
      return {
        book: nextBook,
        progress,
        data: null
      };
    }

    const handle = await localUploadSource.open(nextBook);

    return {
      book: nextBook,
      progress,
      data: handle.data
    };
  },

  async importLocalFiles(files: File[]): Promise<ImportResult> {
    const imported: BookRecord[] = [];
    const failed: Array<{ fileName: string; reason: string }> = [];
    let updatedExistingCount = 0;

    for (const file of files) {
      try {
        const { inspectPdfFile } = await import('../lib/pdf/inspectPdfFile');
        const inspection = await inspectPdfFile(file);
        const existing = await db.books.where('canonicalKey').equals(inspection.canonicalKey).first();
        if (existing) {
          updatedExistingCount += 1;
        }
        const bookId = existing?.bookId ?? crypto.randomUUID();
        const sourceKey = `${LOCAL_SOURCE_INSTANCE_ID}:${inspection.canonicalKey}`;
        const book = normalizeBookRecord(existing, {
          bookId,
          canonicalKey: inspection.canonicalKey,
          sourceType: 'local_upload',
          sourceInstanceId: LOCAL_SOURCE_INSTANCE_ID,
          sourceKey,
          title: inspection.title,
          displayTitle: inspection.title,
          coverRef: bookId,
          pageCount: inspection.pageCount,
          fileName: inspection.fileName,
          fileSize: inspection.fileSize,
          mimeType: inspection.mimeType,
          contentHashPreview: inspection.canonicalKey.slice(0, 16),
          firstPageWidth: inspection.firstPageWidth,
          firstPageHeight: inspection.firstPageHeight,
          availabilityStatus: 'available',
          availabilityReason: undefined,
          lastValidatedAt: nowIso(),
          lastOpenedAt: existing?.lastOpenedAt
        });

        await db.transaction('rw', db.books, db.progress, db.covers, async () => {
          await db.books.put(book);
          await db.covers.put({
            bookId,
            blob: inspection.coverBlob,
            width: inspection.coverWidth,
            height: inspection.coverHeight,
            createdAt: nowIso()
          });

          const progress = await db.progress.get(bookId);
          if (!progress) {
            await db.progress.put(createDefaultProgress(bookId));
          }
        });

        localUploadSource.registerImportedFile(book, file);
        imported.push(book);
      } catch (error) {
        failed.push({
          fileName: file.name,
          reason: error instanceof Error ? error.message : '未知导入错误'
        });
      }
    }

    if (imported.length > 0) {
      emitLibraryChanged();
    }

    return { imported, failed, updatedExistingCount };
  },

  async relinkLocalFile(bookId: string, file: File): Promise<BookRecord> {
    const book = await db.books.get(bookId);

    if (!book) {
      throw new Error('目标书籍不存在。');
    }

    const { inspectPdfFile } = await import('../lib/pdf/inspectPdfFile');
    const inspection = await inspectPdfFile(file);

    if (inspection.canonicalKey !== book.canonicalKey) {
      throw new Error('选择的文件与当前书籍不匹配。');
    }

    const nextBook: BookRecord = {
      ...book,
      availabilityStatus: 'available',
      availabilityReason: undefined,
      lastValidatedAt: nowIso(),
      updatedAt: nowIso()
    };

    await db.transaction('rw', db.books, db.covers, async () => {
      await db.books.put(nextBook);
      await db.covers.put({
        bookId,
        blob: inspection.coverBlob,
        width: inspection.coverWidth,
        height: inspection.coverHeight,
        createdAt: nowIso()
      });
    });

    localUploadSource.registerImportedFile(nextBook, file);
    emitLibraryChanged();
    return nextBook;
  },

  async markBookOpened(bookId: string): Promise<void> {
    const book = await db.books.get(bookId);
    if (!book) {
      return;
    }

    const timestamp = nowIso();
    await db.transaction('rw', db.books, db.appState, async () => {
      await db.books.put({
        ...book,
        lastOpenedAt: timestamp,
        updatedAt: timestamp
      });
      await db.appState.put({
        key: 'singleton',
        lastOpenedBookId: bookId,
        lastOpenSourceContext: `${book.sourceType}:${book.sourceInstanceId}`,
        lastUsedAt: timestamp
      });
    });

    emitLibraryChanged();
  },

  async saveProgress(progress: ProgressRecord): Promise<void> {
    await db.progress.put({
      ...progress,
      updatedAt: nowIso()
    });
  },

  async getCoverBlob(bookId: string): Promise<Blob | null> {
    return (await db.covers.get(bookId))?.blob ?? null;
  },

  async revalidateAllBooks(): Promise<void> {
    const books = await db.books.toArray();
    let changed = false;

    for (const book of books) {
      if (book.sourceType !== 'local_upload') {
        continue;
      }

      const availability = await localUploadSource.revalidate(book);
      if (
        availability.status === book.availabilityStatus &&
        availability.reason === book.availabilityReason
      ) {
        continue;
      }

      await db.books.put({
        ...book,
        availabilityStatus: availability.status,
        availabilityReason: availability.reason,
        lastValidatedAt: nowIso(),
        updatedAt: nowIso()
      });
      changed = true;
    }

    if (changed) {
      emitLibraryChanged();
    }
  }
};
