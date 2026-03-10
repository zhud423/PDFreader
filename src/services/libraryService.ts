import { db } from '../db/database';
import type { BookRecord, BookWithProgress } from '../domain/book';
import type { AppStateRecord, ProgressRecord } from '../domain/progress';
import type { SourceInstanceRecord } from '../domain/source';
import type { TitleReadingState, TitleRecord } from '../domain/title';
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
  duplicateContentCount: number;
  duplicateContentFiles: Array<{
    fileName: string;
    matchedTitleName: string;
    matchedChapterName: string;
  }>;
}

export interface ImportOptions {
  targetTitleId?: string;
  newTitleName?: string;
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
  continueReadingTitle: TitleSummary | null;
  recentBooks: BookWithProgress[];
  availableBooks: BookWithProgress[];
  unavailableBooks: BookWithProgress[];
  titleEntries: TitleSummary[];
  sourceSummaries: SourceSummary[];
}

export interface ReaderSession {
  book: BookRecord;
  title: TitleRecord | null;
  progress: ProgressRecord | null;
  documentSource: DocumentSourceHandle | null;
}

export interface TitleSummary {
  titleId: string;
  displayTitle: string;
  coverBookId?: string | null;
  isFavorite: boolean;
  readingState: TitleReadingState;
  sourceKind: 'local' | 'remote' | 'mixed';
  availability: 'available' | 'partial' | 'unavailable';
  chapterCount: number;
  availableChapterCount: number;
  unavailableChapterCount: number;
  updatedAt: string;
  lastOpenedAt?: string;
  continueReadingChapter: BookWithProgress | null;
  latestChapter: BookWithProgress | null;
}

const PROGRESS_STORAGE_PREFIX = 'pdfreader:progress:';
const TITLE_COVER_PREFIX = 'title-cover:';
const chapterTitleCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeDisplayTitle(input: string): string {
  return input.trim() || '未命名作品';
}

function normalizeTitleReadingState(input?: TitleReadingState): TitleReadingState {
  return input === 'reading' || input === 'finished' ? input : 'idle';
}

function getTitleCoverStorageKey(titleId: string): string {
  return `${TITLE_COVER_PREFIX}${titleId}`;
}

function resolveTitleSourceKind(books: BookWithProgress[]): TitleSummary['sourceKind'] {
  const kinds = new Set(
    books.map((book) => (book.sourceType === 'remote_url' ? 'remote' : 'local'))
  );

  if (kinds.size > 1) {
    return 'mixed';
  }

  return kinds.has('remote') ? 'remote' : 'local';
}

function resolveTitleAvailability(books: BookWithProgress[]): TitleSummary['availability'] {
  const availableCount = books.filter((book) => book.availabilityStatus === 'available').length;

  if (availableCount === 0) {
    return 'unavailable';
  }

  if (availableCount === books.length) {
    return 'available';
  }

  return 'partial';
}

function sortChapters(books: BookWithProgress[]): BookWithProgress[] {
  return [...books].sort((left, right) => {
    const byTitle = chapterTitleCollator.compare(right.displayTitle, left.displayTitle);
    if (byTitle !== 0) {
      return byTitle;
    }

    return right.createdAt.localeCompare(left.createdAt);
  });
}

async function createCoverCacheRecord(coverId: string, file: File) {
  if (!file.type.startsWith('image/')) {
    throw new Error('请选择图片文件作为封面。');
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error('封面图片解析失败。'));
      nextImage.src = objectUrl;
    });
    const targetWidth = Math.min(640, Math.max(240, image.naturalWidth || 320));
    const scale = targetWidth / Math.max(1, image.naturalWidth || targetWidth);
    const targetHeight = Math.max(1, Math.round((image.naturalHeight || targetWidth) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('无法创建封面绘制上下文。');
    }

    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (!value) {
          reject(new Error('封面导出失败。'));
          return;
        }

        resolve(value);
      }, 'image/jpeg', 0.86);
    });

    return {
      bookId: coverId,
      blob,
      width: targetWidth,
      height: targetHeight,
      createdAt: nowIso()
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function getProgressStorageKey(bookId: string): string {
  return `${PROGRESS_STORAGE_PREFIX}${bookId}`;
}

function readProgressSnapshot(bookId: string): ProgressRecord | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getProgressStorageKey(bookId));
    return raw ? (JSON.parse(raw) as ProgressRecord) : null;
  } catch {
    return null;
  }
}

function writeProgressSnapshot(progress: ProgressRecord): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(getProgressStorageKey(progress.bookId), JSON.stringify(progress));
  } catch {
    // Ignore quota/storage failures and keep IndexedDB as the durable source.
  }
}

function pickLatestProgress(
  dbProgress: ProgressRecord | null | undefined,
  snapshotProgress: ProgressRecord | null
): ProgressRecord | null {
  if (!dbProgress) {
    return snapshotProgress ?? null;
  }

  if (!snapshotProgress) {
    return dbProgress;
  }

  return snapshotProgress.updatedAt > dbProgress.updatedAt ? snapshotProgress : dbProgress;
}

async function buildSourceContext(book: BookRecord) {
  return {
    sourceInstance: await sourceService.getSourceInstance(book.sourceInstanceId)
  };
}

function normalizeTitleRecord(
  existing: TitleRecord | undefined,
  params: Omit<TitleRecord, 'createdAt' | 'updatedAt'>
): TitleRecord {
  const timestamp = nowIso();
  return {
    ...params,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
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
    progress: pickLatestProgress(progressMap.get(book.bookId), readProgressSnapshot(book.bookId))
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

async function ensureTitleRecord(params: {
  titleId?: string;
  displayTitle: string;
  coverBookId?: string | null;
  isFavorite?: boolean;
  readingState?: TitleReadingState;
}): Promise<TitleRecord> {
  if (params.titleId) {
    const existing = await db.titles.get(params.titleId);
    if (existing) {
      return existing;
    }
  }

  const displayTitle = normalizeDisplayTitle(params.displayTitle);
  const title = normalizeTitleRecord(undefined, {
    titleId: params.titleId ?? crypto.randomUUID(),
    title: displayTitle,
    displayTitle,
    coverBookId: params.coverBookId ?? null,
    isFavorite: params.isFavorite ?? false,
    readingState: normalizeTitleReadingState(params.readingState),
    lastOpenedAt: undefined
  });
  await db.titles.put(title);
  return title;
}

async function touchTitleRecord(
  title: TitleRecord,
  patch: Partial<
    Pick<
      TitleRecord,
      'displayTitle' | 'title' | 'coverBookId' | 'lastOpenedAt' | 'isFavorite' | 'readingState'
    >
  >
): Promise<TitleRecord> {
  const nextTitle = normalizeTitleRecord(title, {
    titleId: title.titleId,
    title: patch.title ?? title.title,
    displayTitle: patch.displayTitle ?? title.displayTitle,
    coverBookId: patch.coverBookId !== undefined ? patch.coverBookId : title.coverBookId,
    isFavorite: patch.isFavorite ?? title.isFavorite ?? false,
    readingState: normalizeTitleReadingState(patch.readingState ?? title.readingState),
    lastOpenedAt: patch.lastOpenedAt !== undefined ? patch.lastOpenedAt : title.lastOpenedAt
  });
  await db.titles.put(nextTitle);
  return nextTitle;
}

function pickTitleCoverBookId(title: TitleRecord | undefined, books: BookWithProgress[]): string | null {
  if (title?.coverBookId) {
    return title.coverBookId;
  }

  return books[0]?.bookId ?? null;
}

async function buildTitleEntries(books: BookWithProgress[]): Promise<TitleSummary[]> {
  const titles = await db.titles.toArray();
  const titleMap = new Map(titles.map((title) => [title.titleId, title]));
  const bucket = new Map<string, BookWithProgress[]>();

  for (const book of books) {
    const current = bucket.get(book.titleId) ?? [];
    current.push(book);
    bucket.set(book.titleId, current);
  }

  const entries = Array.from(bucket.entries()).map(([titleId, titleBooks]) => {
    const sortedByUpdated = [...titleBooks].sort((left, right) =>
      (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
    );
    const sortedByLastOpened = [...titleBooks].sort((left, right) =>
      (right.lastOpenedAt ?? '').localeCompare(left.lastOpenedAt ?? '')
    );
    const latestChapter = sortedByUpdated[0] ?? null;
    const continueReadingChapter = sortedByLastOpened.find((book) => Boolean(book.lastOpenedAt)) ?? latestChapter;
    const availableChapterCount = titleBooks.filter((book) => book.availabilityStatus === 'available').length;
    const unavailableChapterCount = titleBooks.length - availableChapterCount;
    const title = titleMap.get(titleId);

    return {
      titleId,
      displayTitle: normalizeDisplayTitle(title?.displayTitle ?? continueReadingChapter?.displayTitle ?? latestChapter?.displayTitle ?? '未命名作品'),
      coverBookId: pickTitleCoverBookId(title, titleBooks),
      isFavorite: title?.isFavorite ?? false,
      readingState: normalizeTitleReadingState(title?.readingState),
      sourceKind: resolveTitleSourceKind(titleBooks),
      availability: resolveTitleAvailability(titleBooks),
      chapterCount: titleBooks.length,
      availableChapterCount,
      unavailableChapterCount,
      updatedAt: latestChapter?.updatedAt ?? title?.updatedAt ?? nowIso(),
      lastOpenedAt: continueReadingChapter?.lastOpenedAt ?? title?.lastOpenedAt,
      continueReadingChapter,
      latestChapter
    } satisfies TitleSummary;
  });

  return entries.sort((left, right) =>
    (right.lastOpenedAt ?? right.updatedAt).localeCompare(left.lastOpenedAt ?? left.updatedAt)
  );
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

async function listTitleChapterBooks(titleId: string): Promise<BookWithProgress[]> {
  const books = await listBooksWithProgress();
  return sortChapters(books.filter((book) => book.titleId === titleId));
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
  titleId: string,
  source: SourceInstanceRecord,
  entry: SourceCatalogBook
): BookRecord {
  const displayTitle = entry.displayTitle.trim() || entry.title.trim() || entry.fileName;

  return normalizeBookRecord(existing, {
    bookId: existing?.bookId ?? crypto.randomUUID(),
    titleId,
    contentHash: entry.contentHash,
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
    contentHashPreview: entry.contentHash.slice(0, 16),
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

  await db.transaction('rw', db.books, db.progress, db.titles, async () => {
    for (const entry of catalog) {
      const existing = await findExistingBookForCatalog(source, entry);
      let title =
        existing?.titleId
          ? await ensureTitleRecord({
              titleId: existing.titleId,
              displayTitle: existing.displayTitle,
              coverBookId: existing.coverRef ?? existing.bookId
            })
          : await ensureTitleRecord({
              displayTitle: entry.displayTitle.trim() || entry.title.trim() || entry.fileName
            });
      const nextBook = createRemoteBookRecord(existing, title.titleId, source, entry);

      await db.books.put(nextBook);
      await ensureBookProgress(nextBook.bookId);
      if (!title.coverBookId) {
        title = await touchTitleRecord(title, { coverBookId: nextBook.bookId });
      }

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
    const titleEntries = await buildTitleEntries(books);
    const continueReadingTitle =
      continueReading ? titleEntries.find((entry) => entry.titleId === continueReading.titleId) ?? null : titleEntries[0] ?? null;
    const sourceSummaries = await buildSourceSummaries(books);

    return {
      continueReading,
      continueReadingTitle,
      recentBooks: books,
      availableBooks,
      unavailableBooks,
      titleEntries,
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

    const nextProgress = pickLatestProgress(progress, readProgressSnapshot(bookId));
    if (nextProgress && (!progress || nextProgress.updatedAt > progress.updatedAt)) {
      await db.progress.put(nextProgress);
    }

    return {
      ...book,
      progress: nextProgress
    };
  },

  async getReaderSession(bookId: string): Promise<ReaderSession | null> {
    const book = await db.books.get(bookId);

    if (!book) {
      return null;
    }

    const [title, dbProgress] = await Promise.all([db.titles.get(book.titleId), db.progress.get(bookId)]);
    const progress = pickLatestProgress(dbProgress, readProgressSnapshot(bookId));
    if (progress && (!dbProgress || progress.updatedAt > dbProgress.updatedAt)) {
      await db.progress.put(progress);
    }
    const nextBook = await revalidateBookRecord(book);

    if (nextBook !== book) {
      await db.books.put(nextBook);
      emitLibraryChanged();
    }

    if (nextBook.availabilityStatus !== 'available') {
      return {
        book: nextBook,
        title: title ?? null,
        progress,
        documentSource: null
      };
    }

    try {
      const adapter = getSourceAdapter(nextBook.sourceType);
      const handle = await adapter.open(nextBook, await buildSourceContext(nextBook));

      return {
        book: nextBook,
        title: title ?? null,
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
        title: title ?? null,
        progress,
        documentSource: null
      };
    }
  },

  async importLocalFiles(files: File[], options?: ImportOptions): Promise<ImportResult> {
    await sourceService.ensureLocalSourceInstance();

    const imported: BookRecord[] = [];
    const failed: Array<{ fileName: string; reason: string }> = [];
    let duplicateContentCount = 0;
    const duplicateContentFiles: ImportResult['duplicateContentFiles'] = [];
    let sharedTitle: TitleRecord | null = null;

    if (options?.targetTitleId) {
      sharedTitle = await ensureTitleRecord({
        titleId: options.targetTitleId,
        displayTitle: '未命名作品'
      });
    } else if (options?.newTitleName?.trim()) {
      sharedTitle = await ensureTitleRecord({
        displayTitle: options.newTitleName
      });
    }

    for (const file of files) {
      try {
        const { inspectPdfFile } = await import('../lib/pdf/inspectPdfFile');
        const inspection = await inspectPdfFile(file);
        const sourceKey = `${LOCAL_SOURCE_INSTANCE_ID}:${inspection.contentHash}`;
        let duplicate = await db.books
          .where('[sourceInstanceId+sourceKey]')
          .equals([LOCAL_SOURCE_INSTANCE_ID, sourceKey])
          .first();

        if (duplicate) {
          duplicateContentCount += 1;
          const duplicateTitle = await db.titles.get(duplicate.titleId);
          duplicateContentFiles.push({
            fileName: file.name,
            matchedTitleName: duplicateTitle?.displayTitle ?? '未命名作品',
            matchedChapterName: duplicate.displayTitle
          });
        }

        const bookId = crypto.randomUUID();
        let title =
          sharedTitle ??
          (await ensureTitleRecord({
            displayTitle: inspection.title,
            coverBookId: bookId
          }));
        const book = normalizeBookRecord(undefined, {
          bookId,
          titleId: title.titleId,
          contentHash: inspection.contentHash,
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
          contentHashPreview: inspection.contentHash.slice(0, 16),
          firstPageWidth: inspection.firstPageWidth,
          firstPageHeight: inspection.firstPageHeight,
          availabilityStatus: 'available',
          availabilityReason: undefined,
          lastValidatedAt: nowIso(),
          lastOpenedAt: undefined
        });

        await db.transaction('rw', db.books, db.progress, db.covers, db.titles, async () => {
          await db.books.put(book);
          await db.covers.put({
            bookId,
            blob: inspection.coverBlob,
            width: inspection.coverWidth,
            height: inspection.coverHeight,
            createdAt: nowIso()
          });
          await ensureBookProgress(bookId);
          if (!title.coverBookId) {
            title = await touchTitleRecord(title, { coverBookId: bookId });
            if (sharedTitle?.titleId === title.titleId) {
              sharedTitle = title;
            }
          } else {
            title = await touchTitleRecord(title, {});
            if (sharedTitle?.titleId === title.titleId) {
              sharedTitle = title;
            }
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

    return {
      imported,
      failed,
      duplicateContentCount,
      duplicateContentFiles
    };
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
    const isHashMatch = inspection.contentHash === book.contentHash;

    if (!isHashMatch) {
      throw new Error('选择的文件与当前书籍不匹配。');
    }

    const nextBook: BookRecord = {
      ...book,
      contentHash: inspection.contentHash,
      sourceType: 'local_upload',
      sourceInstanceId: LOCAL_SOURCE_INSTANCE_ID,
      sourceKey: `${LOCAL_SOURCE_INSTANCE_ID}:${inspection.contentHash}`,
      coverRef: book.bookId,
      pageCount: inspection.pageCount,
      fileName: inspection.fileName,
      fileSize: inspection.fileSize,
      mimeType: inspection.mimeType,
      contentHashPreview: inspection.contentHash.slice(0, 16),
      firstPageWidth: inspection.firstPageWidth,
      firstPageHeight: inspection.firstPageHeight,
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
    const title = await db.titles.get(book.titleId);
    await db.transaction('rw', db.books, db.appState, db.titles, async () => {
      await db.books.put({
        ...book,
        lastOpenedAt: timestamp,
        updatedAt: timestamp
      });
      if (title) {
        await db.titles.put({
          ...title,
          readingState: title.readingState === 'finished' ? 'finished' : 'reading',
          lastOpenedAt: timestamp,
          updatedAt: timestamp
        });
      }
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
    const nextProgress = {
      ...progress,
      updatedAt: nowIso()
    };

    writeProgressSnapshot(nextProgress);
    await db.progress.put(nextProgress);
  },

  async getCoverBlob(bookId: string): Promise<Blob | null> {
    return (await db.covers.get(bookId))?.blob ?? null;
  },

  async listTitles(): Promise<TitleSummary[]> {
    return buildTitleEntries(await listBooksWithProgress());
  },

  async listTitleChapters(titleId: string): Promise<BookWithProgress[]> {
    return listTitleChapterBooks(titleId);
  },

  async renameTitle(titleId: string, nextName: string): Promise<TitleRecord> {
    const title = await db.titles.get(titleId);
    if (!title) {
      throw new Error('目标作品不存在。');
    }

    const displayTitle = normalizeDisplayTitle(nextName);
    const nextTitle = await touchTitleRecord(title, {
      title: displayTitle,
      displayTitle
    });
    emitLibraryChanged();
    return nextTitle;
  },

  async renameBook(bookId: string, nextName: string): Promise<BookRecord> {
    const book = await db.books.get(bookId);
    if (!book) {
      throw new Error('目标章节不存在。');
    }

    const displayTitle = normalizeDisplayTitle(nextName);
    const nextBook = normalizeBookRecord(book, {
      ...book,
      displayTitle,
      title: displayTitle
    });
    await db.books.put(nextBook);
    emitLibraryChanged();
    return nextBook;
  },

  async toggleTitleFavorite(titleId: string): Promise<TitleRecord> {
    const title = await db.titles.get(titleId);
    if (!title) {
      throw new Error('目标作品不存在。');
    }

    const nextTitle = await touchTitleRecord(title, {
      isFavorite: !(title.isFavorite ?? false)
    });
    emitLibraryChanged();
    return nextTitle;
  },

  async setTitleReadingState(titleId: string, readingState: TitleReadingState): Promise<TitleRecord> {
    const title = await db.titles.get(titleId);
    if (!title) {
      throw new Error('目标作品不存在。');
    }

    const nextTitle = await touchTitleRecord(title, {
      readingState
    });
    emitLibraryChanged();
    return nextTitle;
  },

  async setTitleCoverFile(titleId: string, file: File): Promise<void> {
    const title = await db.titles.get(titleId);
    if (!title) {
      throw new Error('目标作品不存在。');
    }

    const coverId = getTitleCoverStorageKey(titleId);
    const coverRecord = await createCoverCacheRecord(coverId, file);

    await db.transaction('rw', db.covers, db.titles, async () => {
      await db.covers.put(coverRecord);
      await db.titles.put({
        ...title,
        coverBookId: coverId,
        updatedAt: nowIso()
      });
    });

    emitLibraryChanged();
  },

  async setBookCoverFile(bookId: string, file: File): Promise<void> {
    const book = await db.books.get(bookId);
    if (!book) {
      throw new Error('目标章节不存在。');
    }

    const coverRecord = await createCoverCacheRecord(bookId, file);
    await db.covers.put(coverRecord);
    emitLibraryChanged();
  },

  async removeBook(bookId: string): Promise<void> {
    const book = await db.books.get(bookId);
    if (!book) {
      return;
    }

    const siblings = await db.books.where('titleId').equals(book.titleId).toArray();
    const remainingBooks = siblings.filter((item) => item.bookId !== bookId);
    const title = await db.titles.get(book.titleId);
    const nextCoverBookId =
      title?.coverBookId === bookId ? (remainingBooks[0]?.bookId ?? null) : title?.coverBookId;

    await db.transaction('rw', db.books, db.progress, db.covers, db.titles, async () => {
      await db.books.delete(bookId);
      await db.progress.delete(bookId);
      await db.covers.delete(bookId);

      if (!title) {
        return;
      }

      if (remainingBooks.length === 0) {
        if (title.coverBookId?.startsWith(TITLE_COVER_PREFIX)) {
          await db.covers.delete(title.coverBookId);
        }
        await db.titles.delete(title.titleId);
        return;
      }

      await db.titles.put({
        ...title,
        coverBookId: nextCoverBookId,
        updatedAt: nowIso()
      });
    });

    emitLibraryChanged();
  },

  async removeTitle(titleId: string): Promise<void> {
    const [title, books] = await Promise.all([
      db.titles.get(titleId),
      db.books.where('titleId').equals(titleId).toArray()
    ]);

    await db.transaction('rw', db.books, db.progress, db.covers, db.titles, async () => {
      for (const book of books) {
        await db.books.delete(book.bookId);
        await db.progress.delete(book.bookId);
        await db.covers.delete(book.bookId);
      }

      if (title?.coverBookId?.startsWith(TITLE_COVER_PREFIX)) {
        await db.covers.delete(title.coverBookId);
      }

      await db.titles.delete(titleId);
    });

    emitLibraryChanged();
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
        const catalogByContentHash = new Map(catalog.map((entry) => [entry.contentHash, entry]));

        for (const book of sourceBooks) {
          const entry = catalogBySourceKey.get(book.sourceKey) ?? catalogByContentHash.get(book.contentHash);
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
