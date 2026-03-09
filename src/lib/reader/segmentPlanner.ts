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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function buildReaderLayout(
  pdf: PDFDocumentProxy,
  input: { targetWidth: number; viewportHeight: number; zoomScale: number }
): Promise<ReaderLayout> {
  const pageGap = 18;
  const segmentTargetHeight = clamp(input.viewportHeight * 1.35, 720, 1400);
  const targetWidth = Math.max(320, Math.min(input.targetWidth, 980) - 32) * input.zoomScale;
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

