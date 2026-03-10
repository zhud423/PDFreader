export interface RemoteLibraryBookEntry {
  id: string;
  title: string;
  fileName: string;
  contentHash: string;
  fileSize: number;
  mimeType: string;
  pageCount: number;
  firstPageWidth: number;
  firstPageHeight: number;
  pdfPath: string;
  coverPath?: string;
  updatedAt?: string;
}

export interface RemoteLibraryManifest {
  version: 1;
  title?: string;
  generatedAt?: string;
  books: RemoteLibraryBookEntry[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readRequiredString(record: Record<string, unknown>, key: string, prefix: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${prefix} 缺少有效的 ${key}。`);
  }

  return value.trim();
}

function readRequiredNumber(record: Record<string, unknown>, key: string, prefix: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${prefix} 缺少有效的 ${key}。`);
  }

  return value;
}

function parseBookEntry(value: unknown, index: number): RemoteLibraryBookEntry {
  const prefix = `library.json 第 ${index + 1} 本书`;
  if (!isObject(value)) {
    throw new Error(`${prefix} 结构无效。`);
  }

  const updatedAt = value.updatedAt;
  const coverPath = value.coverPath;

  return {
    id: readRequiredString(value, 'id', prefix),
    title: readRequiredString(value, 'title', prefix),
    fileName: readRequiredString(value, 'fileName', prefix),
    contentHash: readRequiredString(value, 'contentHash', prefix),
    fileSize: readRequiredNumber(value, 'fileSize', prefix),
    mimeType: readRequiredString(value, 'mimeType', prefix),
    pageCount: readRequiredNumber(value, 'pageCount', prefix),
    firstPageWidth: readRequiredNumber(value, 'firstPageWidth', prefix),
    firstPageHeight: readRequiredNumber(value, 'firstPageHeight', prefix),
    pdfPath: readRequiredString(value, 'pdfPath', prefix),
    coverPath: typeof coverPath === 'string' && coverPath.trim() !== '' ? coverPath.trim() : undefined,
    updatedAt: typeof updatedAt === 'string' && updatedAt.trim() !== '' ? updatedAt.trim() : undefined
  };
}

export function parseRemoteLibraryManifest(value: unknown): RemoteLibraryManifest {
  if (!isObject(value)) {
    throw new Error('library.json 结构无效。');
  }

  const version = value.version;
  if (version !== 1 && version !== '1') {
    throw new Error('library.json 版本不受支持，仅支持 version = 1。');
  }

  const books = value.books;
  if (!Array.isArray(books)) {
    throw new Error('library.json 缺少 books 数组。');
  }

  const title = value.title;
  const generatedAt = value.generatedAt;

  return {
    version: 1,
    title: typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined,
    generatedAt:
      typeof generatedAt === 'string' && generatedAt.trim() !== '' ? generatedAt.trim() : undefined,
    books: books.map((entry, index) => parseBookEntry(entry, index))
  };
}
