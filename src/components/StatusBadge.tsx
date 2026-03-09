import { formatAvailabilityLabel } from '../shared/utils/format';
import type { AvailabilityStatus } from '../domain/source';

interface StatusBadgeProps {
  status: AvailabilityStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${status}`}>{formatAvailabilityLabel(status)}</span>;
}

