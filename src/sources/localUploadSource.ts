import type { BookRecord } from '../domain/book';
import { sessionSourceRegistry } from '../lib/session/sessionSourceRegistry';
import type { AvailabilitySnapshot, DocumentSourceHandle, SourceAdapter } from './sourceAdapter';

export const LOCAL_SOURCE_INSTANCE_ID = 'local-device-default';

class LocalUploadSourceAdapter implements SourceAdapter {
  readonly type = 'local_upload' as const;

  registerImportedFile(book: BookRecord, file: File): void {
    sessionSourceRegistry.register(book.sourceKey, file);
  }

  async open(book: BookRecord): Promise<DocumentSourceHandle> {
    const file = sessionSourceRegistry.get(book.sourceKey);

    if (!file) {
      throw new Error('本地源文件已失去访问能力，请重新选择文件。');
    }

    return { kind: 'data', data: await file.arrayBuffer() };
  }

  async revalidate(book: BookRecord): Promise<AvailabilitySnapshot> {
    if (sessionSourceRegistry.has(book.sourceKey)) {
      return { status: 'available' };
    }

    return {
      status: 'needs_relink',
      reason: '本地文件句柄未保留，需重新选择原文件。'
    };
  }
}

export const localUploadSource = new LocalUploadSourceAdapter();
