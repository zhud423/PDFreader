import { db } from '../db/database';
import type { BookRecord, BookWithProgress } from '../domain/book';
import type { AppStateRecord, ProgressRecord } from '../domain/progress';
import type { SourceInstanceRecord } from '../domain/source';
import { emitLibraryChanged } from './libraryEvents';
import { LOCAL_SOURCE_INSTANCE_ID, localUploadSource } from '../sources/localUploadSource';
import type {
  AvailabilitySnapshot,
  DocumentSourceHandle,
  SourceCatalogBook,
  SourceValidationResult
} from '../sources/sourceAdapter';
import { getSourceAdapter } from '../sources/sourceRegistry';
import { sourceService, type RemoteSourceDraft } from './sourceService';

export interface ImportResult {
  imported: BookRecord[];
  failed: Array<{ fileName: string; reason: string }>;
  updatedExistingCount: number;
}

export interface SourceSummary {
  sourceInstanceId: string;
  sourceType: SourceInstanceRecord['sourceType'];
  name: string;
  baseUrl?: string;
  status: SourceInstanceRecord['status'];
  totalBooks: number;
  availableBooks: number;
  unavailableBooks: number;
  updatedAt: string;
}

export interface RemoteSourceSyncResult {
  source: SourceInstanceRecord;
  validation: SourceValidationResult;
  importedCount: number;
  updatedCount: number;
  missingCount: number;
  totalBooks: number;
}

export interface HomeOverview {
  continueReading: BookWithProgress | null;
  recentBooks: BookWithProgress[];
  availableBooks: BookWithProgress[];
  unavailableBooks: BookWithProgress[];
  sourceSummaries: SourceSummary[];
}

export interface ReaderSession {
  book: BookRecord;
  progress: ProgressRecord | null;
  documentSource: DocumentSourceHandle | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function buildSourceContext(book: BookRecord) {
  return {
    sourceInstance: await sourceService.getSourceInstance(book.sourceInstanceId)
  };
}

function applyAvailability(book: BookRecord, availability: AvailabilitySnapshot): BookRecord {
  if (
    availability.status === book.availabilityStatus &&
    availability.reason === book.availabilityReason
  ) {
    return book;
  }

  return {
    ...book,
    availabilityStatus: availability.status,
    availabilityReason: availability.reason,
    lastValidatedAt: nowIso(),
    updatedAt: nowIso()
  };
}

async function revalidateBookRecord(book: BookRecord): Promise<BookRecord> {
  const adapter = getSourceAdapter(book.sourceType);
  const availability = await adapter.revalidate(book, await buildSourceContext(book));

  return applyAvailability(book, availability);
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
    restoreStrategyVersion: 2,
    updatedAt: nowIso()
  };
}

function normalizeBookRecord(
  existing: BookRecord | undefined,
  params: Omit<BookRecord, 'createdAt' | 'updatedAt'>
): BookRecord {
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

async function ensureBookProgress(bookId: string): Promise<void> {
  const progress = await db.progress.get(bookId);
  if (!progress) {
    await db.progress.put(createDefaultProgress(bookId));
  }
}

async function buildSourceSummaries(books: BookRecord[]): Promise<SourceSummary[]> {
  const sources = await sourceService.listSourceInstances();
  const stats = new Map<
    string,
    {
      totalBooks: number;
      availableBooks: number;
      unavailableBooks: number;
    }
  >();

  for (const book of books) {
    const current = stats.get(book.sourceInstanceId) ?? {
      totalBooks: 0,
      availableBooks: 0,
      unavailableBooks: 0
    };
    current.totalBooks += 1;
    if (book.availabilityStatus === 'available') {
      current.availableBooks += 1;
    } else {
      current.unavailableBooks += 1;
    }
    stats.set(book.sourceInstanceId, current);
  }

  return sources.map((source) => {
    const current = stats.get(source.sourceInstanceId) ?? {
      totalBooks: 0,
      availableBooks: 0,
      unavailableBooks: 0
    };

    return {
      sourceInstanceId: source.sourceInstanceId,
      sourceType: source.sourceType,
      name: source.name,
      baseUrl: source.baseUrl,
      status: source.status,
      totalBooks: current.totalBooks,
      availableBooks: current.availableBooks,
      unavailableBooks: current.unavailableBooks,
      updatedAt: source.updatedAt
    };
  });
}

async function findExistingBookForCatalog(
  source: SourceInstanceRecord,
  entry: SourceCatalogBook
): Promise<BookRecord | undefined> {
  return db.books
    .where('[sourceInstanceId+sourceKey]')
    .equals([source.sourceInstanceId, entry.sourceKey])
    .first();
}

function createRemoteBookRecord(
  existing: BookRecord | undefined,
  source: SourceInstanceRecord,
  entry: SourceCatalogBook
): BookRecord {
  const displayTitle = entry.displayTitle.trim() || entry.title.trim() || entry.fileName;

  return normalizeBookRecord(existing, {
    bookId: existing?.bookId ?? crypto.randomUUID(),
    canonicalKey: entry.canonicalKey,
    sourceType: 'remote_url',
    sourceInstanceId: source.sourceInstanceId,
    sourceKey: entry.sourceKey,
    title: entry.title,
    displayTitle,
    coverRef: entry.coverUrl ?? existing?.coverRef ?? null,
    pageCount: entry.pageCount,
    fileName: entry.fileName,
    fileSize: entry.fileSize,
    mimeType: entry.mimeType,
    contentHashPreview: entry.canonicalKey.slice(0, 16),
    firstPageWidth: entry.firstPageWidth,
    firstPageHeight: entry.firstPageHeight,
    availabilityStatus: 'available',
    availabilityReason: undefined,
    lastValidatedAt: nowIso(),
    lastOpenedAt: existing?.lastOpenedAt
  });
}

async function syncRemoteCatalogBooks(
  source: SourceInstanceRecord,
  catalog: SourceCatalogBook[]
): Promise<Pick<RemoteSourceSyncResult, 'importedCount' | 'updatedCount' | 'missingCount' | 'totalBooks'>> {
  const previousBooks = await db.books.where('sourceInstanceId').equals(source.sourceInstanceId).toArray();
  const seenKeys = new Set<string>();
  let importedCount = 0;
  let updatedCount = 0;
  let missingCount = 0;

  await db.transaction('rw', db.books, db.progress, async () => {
    for (const entry of catalog) {
      const existing = await findExistingBookForCatalog(source, entry);
      const nextBook = createRemoteBookRecord(existing, source, entry);

      await db.books.put(nextBook);
      await ensureBookProgress(nextBook.bookId);

      if (existing) {
        updatedCount += 1;
      } else {
        importedCount += 1;
      }

      seenKeys.add(entry.sourceKey);
    }

    for (const book of previousBooks) {
      if (seenKeys.has(book.sourceKey)) {
        continue;
      }

      const nextBook = applyAvailability(book, {
        status: 'missing',
        reason: '远程书源中已找不到该书。'
      });

      if (nextBook === book) {
        continue;
      }

      await db.books.put(nextBook);
      missingCount += 1;
    }
  });

  return {
    importedCount,
    updatedCount,
    missingCount,
    totalBooks: catalog.length
  };
}

async function setRemoteSourceStatus(
  source: SourceInstanceRecord,
  status: SourceInstanceRecord['status']
): Promise<SourceInstanceRecord> {
  if (source.status === status) {
    return source;
  }

  return (await sourceService.updateSourceStatus(source.sourceInstanceId, status)) ?? source;
}

function buildFailedRemoteSyncResult(
  source: SourceInstanceRecord,
  validation: SourceValidationResult
): RemoteSourceSyncResult {
  return {
    source,
    validation,
    importedCount: 0,
    updatedCount: 0,
    missingCount: 0,
    totalBooks: 0
  };
}

export const libraryService = {
  async getHomeOverview(): Promise<HomeOverview> {
    const [books, appState] = await Promise.all([listBooksWithProgress(), getSingletonAppState()]);
    const continueReading =
      books.find((book) => book.bookId === appState.lastOpenedBookId) ?? books.at(0) ?? null;
    const availableBooks = books.filter((book) => book.availabilityStatus === 'available');
    const unavailableBooks = books.filter((book) => book.availabilityStatus !== 'available');
    const sourceSummaries = await buildSourceSummaries(books);

    return {
      continueReading,
      recentBooks: books,
      availableBooks,
      unavailableBooks,
      sourceSummaries
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
    const nextBook = await revalidateBookRecord(book);

    if (nextBook !== book) {
      await db.books.put(nextBook);
      emitLibraryChanged();
    }

    if (nextBook.availabilityStatus !== 'available') {
      return {
        book: nextBook,
        progress,
        documentSource: null
      };
    }

    try {
      const adapter = getSourceAdapter(nextBook.sourceType);
      const handle = await adapter.open(nextBook, await buildSourceContext(nextBook));

      return {
        book: nextBook,
        progress,
        documentSource: handle
      };
    } catch (error) {
      const unavailableBook = applyAvailability(nextBook, {
        status: 'missing',
        reason: error instanceof Error ? error.message : '当前无法打开该来源。'
      });

      if (unavailableBook !== nextBook) {
        await db.books.put(unavailableBook);
        emitLibraryChanged();
      }

      return {
        book: unavailableBook,
        progress,
        documentSource: null
      };
    }
  },

  async importLocalFiles(files: File[]): Promise<ImportResult> {
    await sourceService.ensureLocalSourceInstance();

    const imported: BookRecord[] = [];
    const failed: Array<{ fileName: string; reason: string }> = [];
    let updatedExistingCount = 0;

    for (const file of files) {
      try {
        const { inspectPdfFile } = await import('../lib/pdf/inspectPdfFile');
        const inspection = await inspectPdfFile(file);
        const sourceKey = `${LOCAL_SOURCE_INSTANCE_ID}:${inspection.canonicalKey}`;
        const existing = await db.books
          .where('[sourceInstanceId+sourceKey]')
          .equals([LOCAL_SOURCE_INSTANCE_ID, sourceKey])
          .first();
        if (existing) {
          updatedExistingCount += 1;
        }
        const bookId = existing?.bookId ?? crypto.randomUUID();
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
          await ensureBookProgress(bookId);
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

  async syncRemoteUrlSource(input: RemoteSourceDraft): Promise<RemoteSourceSyncResult> {
    let source = await sourceService.saveRemoteUrlSource(input);
    const adapter = getSourceAdapter('remote_url');

    if (!adapter.validateSource || !adapter.listBooks) {
      throw new Error('当前 remote_url 书源尚未具备同步能力。');
    }

    const validation = await adapter.validateSource(source);
    source = await setRemoteSourceStatus(source, validation.status === 'ready' ? 'active' : 'offline');

    if (validation.sourceName && validation.sourceName !== source.name) {
      source = await sourceService.saveRemoteUrlSource({
        sourceInstanceId: source.sourceInstanceId,
        name: validation.sourceName,
        baseUrl: source.baseUrl ?? input.baseUrl
      });
      source = await setRemoteSourceStatus(source, validation.status === 'ready' ? 'active' : 'offline');
    }

    if (validation.status !== 'ready') {
      source = await sourceService.saveRemoteUrlSource({
        sourceInstanceId: source.sourceInstanceId,
        name: source.name,
        baseUrl: source.baseUrl ?? input.baseUrl
      });
      await this.revalidateAllBooks();
      emitLibraryChanged();
      return buildFailedRemoteSyncResult(source, validation);
    }

    const catalog = await adapter.listBooks(source);
    const syncStats = await syncRemoteCatalogBooks(source, catalog);
    source = await sourceService.saveRemoteUrlSource({
      sourceInstanceId: source.sourceInstanceId,
      name: source.name,
      baseUrl: source.baseUrl ?? input.baseUrl
    });
    emitLibraryChanged();

    return {
      source,
      validation,
      ...syncStats
    };
  },

  async refreshRemoteSource(sourceInstanceId: string): Promise<RemoteSourceSyncResult> {
    const source = await sourceService.getSourceInstance(sourceInstanceId);
    if (!source || source.sourceType !== 'remote_url' || !source.baseUrl) {
      throw new Error('目标远程书源不存在。');
    }

    return this.syncRemoteUrlSource({
      sourceInstanceId: source.sourceInstanceId,
      name: source.name,
      baseUrl: source.baseUrl
    });
  },

  async relinkLocalFile(bookId: string, file: File): Promise<BookRecord> {
    await sourceService.ensureLocalSourceInstance();

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
      sourceType: 'local_upload',
      sourceInstanceId: LOCAL_SOURCE_INSTANCE_ID,
      sourceKey: `${LOCAL_SOURCE_INSTANCE_ID}:${inspection.canonicalKey}`,
      coverRef: book.bookId,
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
    await sourceService.ensureLocalSourceInstance();

    const books = await db.books.toArray();
    const sources = await sourceService.listSourceInstances();
    const sourceMap = new Map(sources.map((source) => [source.sourceInstanceId, source]));
    const changedBooks: BookRecord[] = [];

    for (const book of books) {
      if (book.sourceType === 'local_upload') {
        try {
          const nextBook = await revalidateBookRecord(book);
          if (nextBook !== book) {
            changedBooks.push(nextBook);
          }
        } catch {
          continue;
        }
      }
    }

    const remoteGroups = new Map<string, BookRecord[]>();
    for (const book of books) {
      if (book.sourceType !== 'remote_url') {
        continue;
      }

      const bucket = remoteGroups.get(book.sourceInstanceId) ?? [];
      bucket.push(book);
      remoteGroups.set(book.sourceInstanceId, bucket);
    }

    for (const [sourceInstanceId, sourceBooks] of remoteGroups.entries()) {
      const source = sourceMap.get(sourceInstanceId);
      if (!source || source.sourceType !== 'remote_url') {
        changedBooks.push(
          ...sourceBooks.map((book) =>
            applyAvailability(book, {
              status: 'missing',
              reason: '远程书源实例不存在。'
            })
          )
        );
        continue;
      }

      const adapter = getSourceAdapter('remote_url');
      if (!adapter.listBooks) {
        continue;
      }

      try {
        const catalog = await adapter.listBooks(source);
        await setRemoteSourceStatus(source, 'active');
        const catalogBySourceKey = new Map(catalog.map((entry) => [entry.sourceKey, entry]));
        const catalogByCanonicalKey = new Map(catalog.map((entry) => [entry.canonicalKey, entry]));

        for (const book of sourceBooks) {
          const entry = catalogBySourceKey.get(book.sourceKey) ?? catalogByCanonicalKey.get(book.canonicalKey);
          const nextBook = applyAvailability(
            book,
            entry
              ? { status: 'available' }
              : {
                  status: 'missing',
                  reason: '远程书源中已找不到该书。'
                }
          );

          if (nextBook !== book) {
            changedBooks.push(nextBook);
          }
        }
      } catch (error) {
        await setRemoteSourceStatus(source, 'offline');
        for (const book of sourceBooks) {
          const nextBook = applyAvailability(book, {
            status: 'missing',
            reason: error instanceof Error ? error.message : '远程书源暂不可用。'
          });

          if (nextBook !== book) {
            changedBooks.push(nextBook);
          }
        }
      }
    }

    if (changedBooks.length === 0) {
      return;
    }

    await db.transaction('rw', db.books, async () => {
      for (const book of changedBooks) {
        await db.books.put(book);
      }
    });

    emitLibraryChanged();
  }
};
