export type TitleReadingState = 'idle' | 'reading' | 'finished';

export interface TitleRecord {
  titleId: string;
  title: string;
  displayTitle: string;
  coverBookId?: string | null;
  isFavorite?: boolean;
  readingState?: TitleReadingState;
  lastOpenedAt?: string;
  createdAt: string;
  updatedAt: string;
}
