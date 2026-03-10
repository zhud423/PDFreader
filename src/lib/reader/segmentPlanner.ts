import type { ProgressRecord } from '../../domain/progress';
import type { PDFDocumentProxy } from '../pdf/pdf';

export interface ReaderPageLayout {
  pageIndex: number;
  pageNumber: number;
  renderedWidth: number;
  renderedHeight: number;
  segmentCount: number;
}

export interface ReaderSegment {
  id: string;
  order: number;
  pageIndex: number;
  pageNumber: number;
  segmentIndex: number;
  top: number;
  gapBefore: number;
  width: number;
  height: number;
  offsetY: number;
  scale: number;
}

export interface ReaderLayout {
  pages: ReaderPageLayout[];
  segments: ReaderSegment[];
  totalHeight: number;
  pageGap: number;
  segmentTargetHeight: number;
}

export type ReaderScrollDirection = 'forward' | 'backward' | 'idle';
export type ReaderSegmentRenderMode = 'hot' | 'warm' | 'cold';

export interface ReaderRenderWindow {
  anchorIndex: number;
  visibleStart: number;
  visibleEnd: number;
  hotStart: number;
  hotEnd: number;
  warmStart: number;
  warmEnd: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeSegmentTargetHeight(viewportHeight: number): number {
  return clamp(viewportHeight * 1.35, 720, 1400);
}

function getSegmentAtOffset(layout: ReaderLayout, offset: number): ReaderSegment | null {
  if (layout.segments.length === 0) {
    return null;
  }

  return findSegmentForScroll(layout, Math.max(0, offset));
}

export async function buildReaderLayout(
  pdf: PDFDocumentProxy,
  input: { targetWidth: number; viewportHeight: number; zoomScale: number }
): Promise<ReaderLayout> {
  const pageGap = 0;
  const segmentTargetHeight = computeSegmentTargetHeight(input.viewportHeight);
  const targetWidth = Math.max(320, input.targetWidth) * input.zoomScale;
  const pages: ReaderPageLayout[] = [];
  const segments: ReaderSegment[] = [];
  let cursorTop = 0;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = targetWidth / baseViewport.width;
    const renderedWidth = Math.round(baseViewport.width * scale);
    const renderedHeight = Math.round(baseViewport.height * scale);
    const segmentCount = Math.max(1, Math.ceil(renderedHeight / segmentTargetHeight));

    pages.push({
      pageIndex: pageNumber - 1,
      pageNumber,
      renderedWidth,
      renderedHeight,
      segmentCount
    });

    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const gapBefore = pageNumber > 1 && segmentIndex === 0 ? pageGap : 0;
      const offsetY = segmentIndex * segmentTargetHeight;
      const height = Math.min(segmentTargetHeight, renderedHeight - offsetY);
      const top = cursorTop + gapBefore;

      segments.push({
        id: `p${pageNumber}-s${segmentIndex}`,
        order: segments.length,
        pageIndex: pageNumber - 1,
        pageNumber,
        segmentIndex,
        top,
        gapBefore,
        width: renderedWidth,
        height,
        offsetY,
        scale
      });

      cursorTop = top + height;
    }

    page.cleanup();
  }

  return {
    pages,
    segments,
    totalHeight: cursorTop,
    pageGap,
    segmentTargetHeight
  };
}

export function findSegmentForScroll(layout: ReaderLayout, scrollTop: number): ReaderSegment | null {
  if (layout.segments.length === 0) {
    return null;
  }

  let low = 0;
  let high = layout.segments.length - 1;
  let candidate = layout.segments[0];
  const target = scrollTop + 48;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const segment = layout.segments[middle];

    if (segment.top <= target) {
      candidate = segment;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return candidate;
}

export function resolveProgressSegment(
  layout: ReaderLayout,
  progress: ProgressRecord | null
): ReaderSegment | null {
  if (layout.segments.length === 0) {
    return null;
  }

  if (!progress) {
    return layout.segments[0];
  }

  const exactMatch = layout.segments.find(
    (segment) =>
      segment.pageIndex === progress.pageIndex && segment.segmentIndex === progress.segmentIndex
  );

  if (exactMatch) {
    return exactMatch;
  }

  const samePageSegments = layout.segments.filter((segment) => segment.pageIndex === progress.pageIndex);
  if (samePageSegments.length === 0) {
    return layout.segments.at(-1) ?? null;
  }

  return samePageSegments[Math.min(progress.segmentIndex, samePageSegments.length - 1)] ?? samePageSegments[0];
}

export function resolveProgressScrollTop(
  layout: ReaderLayout,
  progress: ProgressRecord | null
): number {
  const targetSegment = resolveProgressSegment(layout, progress);

  if (!targetSegment) {
    return 0;
  }

  if (!progress) {
    return targetSegment.top;
  }

  const previousSegmentHeight = computeSegmentTargetHeight(progress.viewportHeight || targetSegment.height);
  const ratio = clamp(progress.scrollOffsetWithinSegment / Math.max(1, previousSegmentHeight), 0, 1);
  const offsetWithinSegment = Math.round(ratio * targetSegment.height);

  return targetSegment.top + Math.min(targetSegment.height, Math.max(0, offsetWithinSegment));
}

export function resolveRenderWindow(
  layout: ReaderLayout,
  input: {
    scrollTop: number;
    viewportHeight: number;
    direction: ReaderScrollDirection;
  }
): ReaderRenderWindow {
  const lastIndex = Math.max(0, layout.segments.length - 1);
  const anchorSegment = getSegmentAtOffset(layout, input.scrollTop);
  const visibleStartSegment = getSegmentAtOffset(layout, input.scrollTop - input.viewportHeight * 0.2);
  const visibleEndSegment = getSegmentAtOffset(layout, input.scrollTop + input.viewportHeight * 1.1);

  const anchorIndex = anchorSegment?.order ?? 0;
  const visibleStart = visibleStartSegment?.order ?? anchorIndex;
  const visibleEnd = visibleEndSegment?.order ?? anchorIndex;

  const hotLead = input.direction === 'forward' ? 4 : 2;
  const hotTrail = input.direction === 'backward' ? 4 : 2;
  const warmLead = input.direction === 'forward' ? 8 : 5;
  const warmTrail = input.direction === 'backward' ? 8 : 5;

  const hotStart = clamp(visibleStart - hotTrail, 0, lastIndex);
  const hotEnd = clamp(visibleEnd + hotLead, 0, lastIndex);
  const warmStart = clamp(hotStart - warmTrail, 0, lastIndex);
  const warmEnd = clamp(hotEnd + warmLead, 0, lastIndex);

  return {
    anchorIndex,
    visibleStart,
    visibleEnd,
    hotStart,
    hotEnd,
    warmStart,
    warmEnd
  };
}

export function getSegmentRenderMode(
  renderWindow: ReaderRenderWindow,
  segmentIndex: number
): ReaderSegmentRenderMode {
  if (segmentIndex >= renderWindow.hotStart && segmentIndex <= renderWindow.hotEnd) {
    return 'hot';
  }

  if (segmentIndex >= renderWindow.warmStart && segmentIndex <= renderWindow.warmEnd) {
    return 'warm';
  }

  return 'cold';
}
