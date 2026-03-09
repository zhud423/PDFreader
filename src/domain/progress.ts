export interface ProgressRecord {
  bookId: string;
  pageIndex: number;
  segmentIndex: number;
  scrollOffsetWithinSegment: number;
  zoomScale: number;
  viewportWidth: number;
  viewportHeight: number;
  restoreStrategyVersion: number;
  updatedAt: string;
}

export interface AppStateRecord {
  key: 'singleton';
  lastOpenedBookId?: string;
  lastOpenSourceContext?: string;
  lastUsedAt: string;
}

