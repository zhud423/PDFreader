import type { SourceType } from '../domain/source';
import { localUploadSource } from './localUploadSource';
import { remoteUrlSource } from './remoteUrlSource';
import type { SourceAdapter } from './sourceAdapter';

const adapters: Partial<Record<SourceType, SourceAdapter>> = {
  local_upload: localUploadSource,
  remote_url: remoteUrlSource
};

export function getSourceAdapter(sourceType: SourceType): SourceAdapter {
  const adapter = adapters[sourceType];

  if (!adapter) {
    throw new Error(`当前尚未接入 ${sourceType} 来源适配器。`);
  }

  return adapter;
}
