import { db } from '../db/database';
import type { SourceInstanceRecord } from '../domain/source';
import { LOCAL_SOURCE_INSTANCE_ID } from '../sources/localUploadSource';
import { normalizeRemoteBaseUrl } from '../sources/remoteUrlSource';

export interface RemoteSourceDraft {
  sourceInstanceId?: string;
  name: string;
  baseUrl: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeSource(
  existing: SourceInstanceRecord | undefined,
  input: Omit<SourceInstanceRecord, 'createdAt' | 'updatedAt'>
): SourceInstanceRecord {
  const timestamp = nowIso();

  return {
    ...input,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

export const sourceService = {
  async ensureLocalSourceInstance(): Promise<SourceInstanceRecord> {
    const existing = await db.sources.get(LOCAL_SOURCE_INSTANCE_ID);
    if (
      existing &&
      existing.sourceType === 'local_upload' &&
      existing.name === '当前设备' &&
      existing.status === 'active'
    ) {
      return existing;
    }

    const record = normalizeSource(existing, {
      sourceInstanceId: LOCAL_SOURCE_INSTANCE_ID,
      sourceType: 'local_upload',
      name: '当前设备',
      status: 'active'
    });

    await db.sources.put(record);
    return record;
  },

  async getSourceInstance(sourceInstanceId: string): Promise<SourceInstanceRecord | undefined> {
    if (sourceInstanceId === LOCAL_SOURCE_INSTANCE_ID) {
      return this.ensureLocalSourceInstance();
    }

    return db.sources.get(sourceInstanceId);
  },

  async listSourceInstances(): Promise<SourceInstanceRecord[]> {
    await this.ensureLocalSourceInstance();
    return db.sources.orderBy('updatedAt').reverse().toArray();
  },

  async saveRemoteUrlSource(input: RemoteSourceDraft): Promise<SourceInstanceRecord> {
    const normalizedBaseUrl = normalizeRemoteBaseUrl(input.baseUrl);
    const existingById = input.sourceInstanceId ? await db.sources.get(input.sourceInstanceId) : undefined;
    const existingByBaseUrl = existingById
      ? undefined
      : await db.sources
          .filter((source) => source.sourceType === 'remote_url' && source.baseUrl === normalizedBaseUrl)
          .first();
    const existing = existingById ?? existingByBaseUrl;
    const sourceInstanceId = existing?.sourceInstanceId ?? input.sourceInstanceId ?? `remote-${crypto.randomUUID()}`;

    const record = normalizeSource(existing, {
      sourceInstanceId,
      sourceType: 'remote_url',
      name: input.name.trim() || '局域网书源',
      baseUrl: normalizedBaseUrl,
      authMode: 'none',
      status: existing?.status ?? 'active'
    });

    await db.sources.put(record);
    return record;
  },

  async updateSourceStatus(
    sourceInstanceId: string,
    status: SourceInstanceRecord['status']
  ): Promise<SourceInstanceRecord | undefined> {
    const existing = await db.sources.get(sourceInstanceId);
    if (!existing) {
      return undefined;
    }

    const next: SourceInstanceRecord = {
      ...existing,
      status,
      updatedAt: nowIso()
    };
    await db.sources.put(next);
    return next;
  }
};
