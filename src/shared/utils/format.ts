import type { AvailabilityStatus } from '../../domain/source';
import type { ProgressRecord } from '../../domain/progress';

const relativeFormatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

export function formatRelativeTime(value?: string): string {
  if (!value) {
    return '未开始';
  }

  const diff = new Date(value).getTime() - Date.now();
  const seconds = Math.round(diff / 1000);
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);

  if (Math.abs(seconds) < 60) {
    return relativeFormatter.format(seconds, 'second');
  }

  if (Math.abs(minutes) < 60) {
    return relativeFormatter.format(minutes, 'minute');
  }

  if (Math.abs(hours) < 24) {
    return relativeFormatter.format(hours, 'hour');
  }

  return relativeFormatter.format(days, 'day');
}

export function formatProgressSummary(progress: ProgressRecord | null): string {
  if (!progress) {
    return '未开始';
  }

  return `第 ${progress.pageIndex + 1} 页 · 已保存`;
}

export function formatAvailabilityLabel(status: AvailabilityStatus): string {
  switch (status) {
    case 'available':
      return '可用';
    case 'needs_relink':
      return '需重选文件';
    case 'missing':
      return '不可用';
    case 'failed':
      return '解析失败';
    default:
      return '未知状态';
  }
}

