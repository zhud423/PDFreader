export type SourceType =
  | 'local_upload'
  | 'remote_url'
  | 'unavailable'
  | 'native_file'
  | 'share_import';

export type AvailabilityStatus = 'available' | 'needs_relink' | 'missing' | 'failed';

export interface SourceInstanceRecord {
  sourceInstanceId: string;
  sourceType: SourceType;
  name: string;
  baseUrl?: string;
  authMode?: string;
  status: 'active' | 'offline' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

