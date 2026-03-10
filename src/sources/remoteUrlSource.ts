import type { BookRecord } from '../domain/book';
import { parseRemoteLibraryManifest, type RemoteLibraryBookEntry } from '../domain/remoteLibrary';
import type { SourceInstanceRecord } from '../domain/source';
import type {
  AvailabilitySnapshot,
  DocumentSourceHandle,
  SourceAdapter,
  SourceCatalogBook,
  SourceValidationResult
} from './sourceAdapter';

export const REMOTE_SOURCE_MANIFEST_FILE = 'library.json';

function normalizeRemoteBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error('远程书源缺少 baseUrl。');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('远程书源 URL 无效。');
  }

  parsed.hash = '';
  parsed.search = '';

  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function buildManifestUrl(source: SourceInstanceRecord): string {
  return new URL(REMOTE_SOURCE_MANIFEST_FILE, `${normalizeRemoteBaseUrl(source.baseUrl ?? '')}/`).toString();
}

function resolveAssetUrl(source: SourceInstanceRecord, path: string): string {
  return new URL(path, `${normalizeRemoteBaseUrl(source.baseUrl ?? '')}/`).toString();
}

async function fetchManifest(source: SourceInstanceRecord) {
  const response = await fetch(buildManifestUrl(source), {
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`书源目录不可用（HTTP ${response.status}）。`);
  }

  return parseRemoteLibraryManifest(await response.json());
}

function findBookEntry(manifestBooks: RemoteLibraryBookEntry[], book: BookRecord): RemoteLibraryBookEntry | null {
  return (
    manifestBooks.find((entry) => entry.id === book.sourceKey) ??
    manifestBooks.find((entry) => entry.contentHash === book.contentHash) ??
    null
  );
}

function mapValidationError(error: unknown): SourceValidationResult {
  const reason = error instanceof Error ? error.message : '无法连接到远程书源。';

  if (reason.startsWith('library.json')) {
    return {
      status: 'invalid',
      reason
    };
  }

  if (reason.includes('HTTP 404') || reason.includes('HTTP 400')) {
    return {
      status: 'invalid',
      reason
    };
  }

  return {
    status: 'offline',
    reason
  };
}

class RemoteUrlSourceAdapter implements SourceAdapter {
  readonly type = 'remote_url' as const;

  async validateSource(source: SourceInstanceRecord): Promise<SourceValidationResult> {
    try {
      const manifest = await fetchManifest(source);
      return {
        status: 'ready',
        sourceName: manifest.title ?? source.name,
        bookCount: manifest.books.length
      };
    } catch (error) {
      return mapValidationError(error);
    }
  }

  async listBooks(source: SourceInstanceRecord): Promise<SourceCatalogBook[]> {
    const manifest = await fetchManifest(source);

    return manifest.books.map((entry) => ({
      sourceKey: entry.id,
      contentHash: entry.contentHash,
      title: entry.title,
      displayTitle: entry.title,
      fileName: entry.fileName,
      fileSize: entry.fileSize,
      mimeType: entry.mimeType,
      pageCount: entry.pageCount,
      firstPageWidth: entry.firstPageWidth,
      firstPageHeight: entry.firstPageHeight,
      coverUrl: entry.coverPath ? resolveAssetUrl(source, entry.coverPath) : undefined,
      updatedAt: entry.updatedAt
    }));
  }

  async open(book: BookRecord, context?: { sourceInstance?: SourceInstanceRecord }): Promise<DocumentSourceHandle> {
    const source = context?.sourceInstance;
    if (!source) {
      throw new Error('远程书源实例不存在。');
    }

    const manifest = await fetchManifest(source);
    const entry = findBookEntry(manifest.books, book);
    if (!entry) {
      throw new Error('远程书源中找不到对应书籍。');
    }

    return {
      kind: 'url',
      url: resolveAssetUrl(source, entry.pdfPath)
    };
  }

  async revalidate(
    book: BookRecord,
    context?: { sourceInstance?: SourceInstanceRecord }
  ): Promise<AvailabilitySnapshot> {
    const source = context?.sourceInstance;
    if (!source) {
      return {
        status: 'missing',
        reason: '远程书源实例不存在。'
      };
    }

    try {
      const manifest = await fetchManifest(source);
      const entry = findBookEntry(manifest.books, book);
      if (!entry) {
        return {
          status: 'missing',
          reason: '远程书源中已找不到该书。'
        };
      }

      return { status: 'available' };
    } catch (error) {
      return {
        status: 'missing',
        reason: error instanceof Error ? error.message : '远程书源暂不可用。'
      };
    }
  }
}

export const remoteUrlSource = new RemoteUrlSourceAdapter();
export { normalizeRemoteBaseUrl };
