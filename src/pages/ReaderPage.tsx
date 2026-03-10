import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { BookWithProgress } from '../domain/book';
import type { ProgressRecord } from '../domain/progress';
import { CoverImage } from '../components/CoverImage';
import { subscribePageLifecycle } from '../lib/platform/pageLifecycle';
import { getDocument, type PDFDocumentProxy } from '../lib/pdf/pdf';
import {
  buildReaderLayout,
  findSegmentForScroll,
  getSegmentRenderMode,
  resolveProgressScrollTop,
  resolveProgressSegment,
  resolveRenderWindow,
  type ReaderLayout,
  type ReaderRenderWindow,
  type ReaderScrollDirection,
  type ReaderSegment,
  type ReaderSegmentRenderMode
} from '../lib/reader/segmentPlanner';
import { StatusBadge } from '../components/StatusBadge';
import { libraryService, type ReaderSession } from '../services/libraryService';
import { subscribeLibraryChanged } from '../services/libraryEvents';
import { formatProgressSummary } from '../shared/utils/format';

interface RenderReport {
  segmentId: string;
  durationMs: number;
  qualityScale: number;
}

const TAP_ZONE_RATIO = 1 / 3;
const READER_SETTINGS_STORAGE_KEY = 'pdfreader:reader-settings';

interface ReaderSettings {
  tapStepEnabled: boolean;
  tapStepRatio: number;
  showPageSeparators: boolean;
}

function loadReaderSettings(): ReaderSettings {
  if (typeof window === 'undefined') {
    return {
      tapStepEnabled: true,
      tapStepRatio: 0.9,
      showPageSeparators: true
    };
  }

  try {
    const raw = window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {
        tapStepEnabled: true,
        tapStepRatio: 0.9,
        showPageSeparators: true
      };
    }

    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    return {
      tapStepEnabled: parsed.tapStepEnabled ?? true,
      tapStepRatio: parsed.tapStepRatio ?? 0.9,
      showPageSeparators: parsed.showPageSeparators ?? true
    };
  } catch {
    return {
      tapStepEnabled: true,
      tapStepRatio: 0.9,
      showPageSeparators: true
    };
  }
}

interface RenderedSegmentProps {
  pdf: PDFDocumentProxy;
  segment: ReaderSegment;
  renderMode: ReaderSegmentRenderMode;
  showPageSeparators: boolean;
  reportRenderedRef: MutableRefObject<(report: RenderReport) => void>;
}

function isRenderingCancelledError(value: unknown): boolean {
  return value instanceof Error && value.name === 'RenderingCancelledException';
}

function buildRenderScaleCandidates(): number[] {
  const devicePixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  const candidates = [devicePixelRatio, Math.min(1.5, devicePixelRatio), 1];

  return Array.from(new Set(candidates.map((value) => Number(value.toFixed(2))))).sort((a, b) => b - a);
}

function clearCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d');
  context?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
}

function RenderedSegment({
  pdf,
  segment,
  renderMode,
  showPageSeparators,
  reportRenderedRef
}: RenderedSegmentProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderSignatureRef = useRef<string>('');
  const renderRunRef = useRef(0);
  const [renderState, setRenderState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const renderSignature = `${segment.id}:${Math.round(segment.scale * 1000)}:${Math.round(segment.width)}x${Math.round(segment.height)}`;

    if (renderMode === 'cold') {
      renderSignatureRef.current = '';
      clearCanvas(canvas);
      setRenderState('idle');
      setError(null);
      return;
    }

    if (renderSignatureRef.current === renderSignature) {
      return;
    }

    const runId = renderRunRef.current + 1;
    renderRunRef.current = runId;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    const isStaleRun = () => cancelled || runId !== renderRunRef.current;

    const render = async () => {
      setRenderState('loading');
      setError(null);

      const page = await pdf.getPage(segment.pageNumber);
      const candidates = buildRenderScaleCandidates();
      const startedAt = performance.now();
      let lastError: unknown = null;

      try {
        if (isStaleRun()) {
          return;
        }

        for (const qualityScale of candidates) {
          if (isStaleRun()) {
            return;
          }

          const viewport = page.getViewport({ scale: segment.scale * qualityScale });
          const translateY = Math.round(segment.offsetY * qualityScale);
          canvas.width = Math.max(1, Math.round(segment.width * qualityScale));
          canvas.height = Math.max(1, Math.round(segment.height * qualityScale));
          canvas.style.width = `${Math.round(segment.width)}px`;
          canvas.style.height = `${Math.round(segment.height)}px`;

          const context = canvas.getContext('2d');
          if (!context) {
            throw new Error('无法创建分段渲染上下文。');
          }

          context.setTransform(1, 0, 0, 1, 0, 0);
          context.clearRect(0, 0, canvas.width, canvas.height);

          try {
            renderTask = page.render({
              canvasContext: context,
              viewport,
              transform: [1, 0, 0, 1, 0, -translateY]
            });
            await renderTask.promise;

            if (isStaleRun()) {
              return;
            }

            renderSignatureRef.current = renderSignature;
            setRenderState('ready');
            reportRenderedRef.current({
              segmentId: segment.id,
              durationMs: performance.now() - startedAt,
              qualityScale
            });
            return;
          } catch (value: unknown) {
            if (isRenderingCancelledError(value) || cancelled) {
              throw value;
            }

            lastError = value;
            clearCanvas(canvas);
          }
        }
      } finally {
        page.cleanup();
      }

      throw lastError ?? new Error('分段渲染失败');
    };

    void render().catch((value: unknown) => {
      if (!isStaleRun() && !isRenderingCancelledError(value)) {
        setRenderState('error');
        setError(value instanceof Error ? value.message : '分段渲染失败');
      }
    });

    return () => {
      cancelled = true;
      renderRunRef.current += 1;
      renderTask?.cancel();
    };
  }, [
    pdf,
    renderMode,
    reportRenderedRef,
    segment.height,
    segment.id,
    segment.offsetY,
    segment.pageNumber,
    segment.scale,
    segment.width
  ]);

  const shouldKeepCanvas = renderMode !== 'cold';

  return (
    <section
      className={`reader-segment-shell ${showPageSeparators && segment.pageNumber > 1 && segment.segmentIndex === 0 ? 'is-page-start' : ''}`}
      style={{ height: `${segment.height + segment.gapBefore}px`, paddingTop: `${segment.gapBefore}px` }}
    >
      <div className="reader-segment-frame" style={{ width: `${segment.width}px`, height: `${segment.height}px` }}>
        {shouldKeepCanvas && renderState !== 'ready' ? (
          <div className={`reader-segment-placeholder ${renderState === 'loading' ? 'is-loading' : ''}`} />
        ) : null}
        {shouldKeepCanvas ? <canvas ref={canvasRef} className="reader-segment-canvas" /> : null}
        {error ? <div className="reader-inline-message reader-inline-message--overlay">{error}</div> : null}
      </div>
    </section>
  );
}

interface ReaderViewportProps {
  session: ReaderSession;
  chromeVisible: boolean;
  zoomScale: number;
  settings: ReaderSettings;
  onToggleChrome: () => void;
  onSettingsChange: (patch: Partial<ReaderSettings>) => void;
  onOpenMore: () => void;
  onOpenChapterList: () => void;
  onOpenPrevChapter: () => void;
  onOpenNextChapter: () => void;
  hasPrevChapter: boolean;
  hasNextChapter: boolean;
  isChapterSwitching: boolean;
}

function createRestoreWindow(layout: ReaderLayout, segment: ReaderSegment): ReaderRenderWindow {
  const lastIndex = Math.max(0, layout.segments.length - 1);
  const hotStart = Math.max(0, segment.order - 1);
  const hotEnd = Math.min(lastIndex, segment.order + 2);
  const warmStart = Math.max(0, hotStart - 3);
  const warmEnd = Math.min(lastIndex, hotEnd + 4);

  return {
    anchorIndex: segment.order,
    visibleStart: segment.order,
    visibleEnd: segment.order,
    hotStart,
    hotEnd,
    warmStart,
    warmEnd
  };
}

interface DuplicateChapterHint {
  matchedChapterName: string;
  matchedFileName: string;
}

function buildDuplicateChapterHintMap(chapters: BookWithProgress[]): Map<string, DuplicateChapterHint> {
  const hintMap = new Map<string, DuplicateChapterHint>();
  const grouped = new Map<string, BookWithProgress[]>();

  for (const chapter of chapters) {
    const group = grouped.get(chapter.contentHash);
    if (group) {
      group.push(chapter);
    } else {
      grouped.set(chapter.contentHash, [chapter]);
    }
  }

  for (const group of grouped.values()) {
    if (group.length <= 1) {
      continue;
    }

    const sorted = [...group].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const anchor = sorted[0];

    for (let index = 1; index < sorted.length; index += 1) {
      hintMap.set(sorted[index].bookId, {
        matchedChapterName: anchor.displayTitle,
        matchedFileName: anchor.fileName
      });
    }
  }

  return hintMap;
}

function ReaderViewport({
  session,
  chromeVisible,
  zoomScale,
  settings,
  onToggleChrome,
  onSettingsChange,
  onOpenMore,
  onOpenChapterList,
  onOpenPrevChapter,
  onOpenNextChapter,
  hasPrevChapter,
  hasNextChapter,
  isChapterSwitching
}: ReaderViewportProps) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderedSegmentsRef = useRef(new Set<string>());
  const saveTimerRef = useRef<number | null>(null);
  const lastProgressRef = useRef<ProgressRecord | null>(session.progress);
  const restoredRef = useRef(false);
  const reportRenderedRef = useRef<(report: RenderReport) => void>(() => {});
  const lastScrollTopRef = useRef(0);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [layout, setLayout] = useState<ReaderLayout | null>(null);
  const [viewportSnapshot, setViewportSnapshot] = useState({
    width: 0,
    height: 0,
    scrollTop: 0
  });
  const [currentPage, setCurrentPage] = useState((session.progress?.pageIndex ?? 0) + 1);
  const [currentSegment, setCurrentSegment] = useState((session.progress?.segmentIndex ?? 0) + 1);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renderTick, setRenderTick] = useState(0);
  const [scrollDirection, setScrollDirection] = useState<ReaderScrollDirection>('idle');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadDurationMs, setLoadDurationMs] = useState<number | null>(null);
  const [lastRenderMetric, setLastRenderMetric] = useState<{ durationMs: number; qualityScale: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  reportRenderedRef.current = (report) => {
    if (!renderedSegmentsRef.current.has(report.segmentId)) {
      renderedSegmentsRef.current.add(report.segmentId);
      setRenderTick((value) => value + 1);
    }

    setLastRenderMetric({
      durationMs: Math.round(report.durationMs),
      qualityScale: report.qualityScale
    });
  };

  useEffect(() => {
    lastProgressRef.current = session.progress;
  }, [session.book.bookId, session.progress]);

  useEffect(() => {
    let cancelled = false;
    let activePdf: PDFDocumentProxy | null = null;

    const loadDocument = async () => {
      if (!session.documentSource) {
        setLoadState('error');
        setLoadError('当前没有可用的 PDF 数据。');
        return;
      }

      const startedAt = performance.now();
      const task =
        session.documentSource.kind === 'data'
          ? getDocument({ data: session.documentSource.data.slice(0) })
          : getDocument(session.documentSource.url);
      const loadedPdf = await task.promise;
      activePdf = loadedPdf;

      if (cancelled) {
        await loadedPdf.destroy();
        return;
      }

      setPdf(loadedPdf);
      setLoadDurationMs(Math.round(performance.now() - startedAt));
      setLoadError(null);
    };

    setPdf(null);
    setLayout(null);
    setLoadState('loading');
    setLoadError(null);
    void loadDocument().catch((error) => {
      if (!cancelled) {
        setLoadState('error');
        setLoadError(error instanceof Error ? error.message : '文档加载失败');
      }
    });

    return () => {
      cancelled = true;
      if (activePdf) {
        void activePdf.destroy();
      }
    };
  }, [loadAttempt, session.documentSource]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(0);
      if (!entry) {
        return;
      }

      setViewportSnapshot((previous) => ({
        ...previous,
        width: entry.contentRect.width,
        height: entry.contentRect.height
      }));
    });

    observer.observe(container);
    setViewportSnapshot({
      width: container.clientWidth,
      height: container.clientHeight,
      scrollTop: container.scrollTop
    });
    lastScrollTopRef.current = container.scrollTop;

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || viewportSnapshot.width === 0 || viewportSnapshot.height === 0) {
      return;
    }

    let cancelled = false;

    const buildLayout = async () => {
      setLoadState('loading');
      const nextLayout = await buildReaderLayout(pdf, {
        targetWidth: viewportSnapshot.width,
        viewportHeight: viewportSnapshot.height,
        zoomScale
      });

      if (!cancelled) {
        setLayout(nextLayout);
        setLoadState('ready');
        setLoadError(null);
      }
    };

    void buildLayout().catch((error) => {
      if (!cancelled) {
        setLoadState('error');
        setLoadError(error instanceof Error ? error.message : '阅读布局计算失败');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [pdf, viewportSnapshot.height, viewportSnapshot.width, zoomScale]);

  useEffect(() => {
    if (!layout) {
      return;
    }

    const restoreProgress = lastProgressRef.current ?? session.progress;
    const initialSegment = resolveProgressSegment(layout, restoreProgress);
    if (!initialSegment) {
      return;
    }

    lastProgressRef.current = {
      bookId: session.book.bookId,
      pageIndex: initialSegment.pageIndex,
      segmentIndex: initialSegment.segmentIndex,
      scrollOffsetWithinSegment: restoreProgress?.scrollOffsetWithinSegment ?? 0,
      zoomScale,
      viewportWidth: viewportSnapshot.width,
      viewportHeight: viewportSnapshot.height,
      restoreStrategyVersion: 2,
      updatedAt: new Date().toISOString()
    };
  }, [layout, session.book.bookId, session.progress, viewportSnapshot.height, viewportSnapshot.width, zoomScale]);

  const captureProgressFromViewport = () => {
    const container = containerRef.current;
    if (!container || !layout) {
      return;
    }

    const scrollTop = container.scrollTop;
    const activeSegment = findSegmentForScroll(layout, scrollTop);
    if (!activeSegment) {
      return;
    }

    lastScrollTopRef.current = scrollTop;
    lastProgressRef.current = {
      bookId: session.book.bookId,
      pageIndex: activeSegment.pageIndex,
      segmentIndex: activeSegment.segmentIndex,
      scrollOffsetWithinSegment: Math.max(0, scrollTop - activeSegment.top),
      zoomScale,
      viewportWidth: container.clientWidth,
      viewportHeight: container.clientHeight,
      restoreStrategyVersion: 2,
      updatedAt: new Date().toISOString()
    };
  };

  const flushProgress = async () => {
    captureProgressFromViewport();

    if (!lastProgressRef.current) {
      return;
    }

    await libraryService.saveProgress(lastProgressRef.current);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !layout) {
      return;
    }

    let rafId = 0;

    const updateProgress = () => {
      rafId = 0;
      const scrollTop = container.scrollTop;
      const delta = scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;

      if (delta > 10) {
        setScrollDirection('forward');
      } else if (delta < -10) {
        setScrollDirection('backward');
      }

      const activeSegment = findSegmentForScroll(layout, scrollTop);

      setViewportSnapshot((previous) =>
        previous.scrollTop === scrollTop ? previous : { ...previous, scrollTop }
      );

      if (!activeSegment) {
        return;
      }

      setCurrentPage(activeSegment.pageNumber);
      setCurrentSegment(activeSegment.segmentIndex + 1);
      captureProgressFromViewport();

      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = window.setTimeout(() => {
        void flushProgress();
      }, 220);
    };

    const onScroll = () => {
      if (rafId) {
        return;
      }

      rafId = window.requestAnimationFrame(updateProgress);
    };

    container.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
      void flushProgress();
      container.removeEventListener('scroll', onScroll);
    };
  }, [layout, session.book.bookId, zoomScale]);

  useEffect(() => {
    const unsubscribe = subscribePageLifecycle({
      onHidden: () => {
        void flushProgress();
      },
      onPageHide: () => {
        void flushProgress();
      }
    });

    return unsubscribe;
  }, [layout, zoomScale]);

  useEffect(() => {
    if (!lastProgressRef.current) {
      return;
    }

    lastProgressRef.current = {
      ...lastProgressRef.current,
      zoomScale,
      restoreStrategyVersion: 2
    };
  }, [zoomScale]);

  useEffect(() => {
    renderedSegmentsRef.current.clear();
    restoredRef.current = false;
    setRenderTick(0);
  }, [layout]);

  const pendingRestoreProgress = !restoredRef.current ? lastProgressRef.current ?? session.progress : null;
  const pendingRestoreSegment =
    layout && pendingRestoreProgress ? resolveProgressSegment(layout, pendingRestoreProgress) : null;

  const renderWindow =
    layout && pendingRestoreSegment
      ? createRestoreWindow(layout, pendingRestoreSegment)
      : layout
        ? resolveRenderWindow(layout, {
            scrollTop: viewportSnapshot.scrollTop,
            viewportHeight: viewportSnapshot.height,
            direction: scrollDirection
          })
        : null;

  useEffect(() => {
    if (!layout || restoredRef.current) {
      return;
    }

    const restoreProgress = lastProgressRef.current ?? session.progress;
    const targetSegment = resolveProgressSegment(layout, restoreProgress);
    if (!targetSegment) {
      return;
    }

    if (!renderedSegmentsRef.current.has(targetSegment.id)) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const targetTop = resolveProgressScrollTop(layout, restoreProgress);
    container.scrollTo({
      top: targetTop,
      behavior: 'auto'
    });
    lastScrollTopRef.current = targetTop;
    setViewportSnapshot((previous) => ({ ...previous, scrollTop: targetTop }));
    setCurrentPage(targetSegment.pageNumber);
    setCurrentSegment(targetSegment.segmentIndex + 1);
    restoredRef.current = true;
    setScrollDirection('idle');

    lastProgressRef.current = {
      bookId: session.book.bookId,
      pageIndex: targetSegment.pageIndex,
      segmentIndex: targetSegment.segmentIndex,
      scrollOffsetWithinSegment: Math.max(0, targetTop - targetSegment.top),
      zoomScale,
      viewportWidth: container.clientWidth,
      viewportHeight: container.clientHeight,
      restoreStrategyVersion: 2,
      updatedAt: new Date().toISOString()
    };

    void flushProgress();
  }, [layout, renderTick, session.book.bookId, session.progress, zoomScale]);

  useEffect(() => {
    void libraryService.markBookOpened(session.book.bookId);
  }, [session.book.bookId]);

  if (session.book.availabilityStatus !== 'available' || !session.documentSource) {
    return (
      <section className="reader-fallback">
        <div className="reader-fallback__panel">
          <StatusBadge status={session.book.availabilityStatus} />
          <h2>{session.book.displayTitle}</h2>
          <p>{session.book.availabilityReason ?? '当前无法直接打开该条目。'}</p>
          <Link className="action-button action-button--primary" to="/">
            返回首页
          </Link>
        </div>
      </section>
    );
  }

  const hotCount = renderWindow ? renderWindow.hotEnd - renderWindow.hotStart + 1 : 0;
  const warmCount = renderWindow
    ? Math.max(0, renderWindow.warmEnd - renderWindow.warmStart + 1 - hotCount)
    : 0;
  const totalPages = layout?.pages.length ?? session.book.pageCount;

  const handleViewportTap = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button,a,input')) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    const topZoneMax = rect.height * TAP_ZONE_RATIO;
    const bottomZoneMin = rect.height * (1 - TAP_ZONE_RATIO);
    const stepDistance = Math.max(180, Math.round(rect.height * settings.tapStepRatio));

    if (!settings.tapStepEnabled) {
      onToggleChrome();
      return;
    }

    if (offsetY <= topZoneMax) {
      container.scrollBy({
        top: -stepDistance,
        behavior: 'smooth'
      });
      return;
    }

    if (offsetY >= bottomZoneMin) {
      container.scrollBy({
        top: stepDistance,
        behavior: 'smooth'
      });
      return;
    }

    onToggleChrome();
  };

  const maxScrollableTop = layout ? Math.max(0, layout.totalHeight - viewportSnapshot.height) : 0;
  const fallbackPageRatio =
    totalPages > 1 ? (Math.min(Math.max(1, currentPage), totalPages) - 1) / (totalPages - 1) : 0;
  const scrollRatio = layout ? (maxScrollableTop > 0 ? viewportSnapshot.scrollTop / maxScrollableTop : 0) : fallbackPageRatio;
  const safeScrollRatio = Math.min(1, Math.max(0, scrollRatio));
  const progressPercent = Math.round(safeScrollRatio * 100);
  const sliderValue = Math.round(safeScrollRatio * 1000);

  const handleProgressJump = (nextSliderValue: number) => {
    if (!layout || !containerRef.current) {
      return;
    }

    const targetTop = maxScrollableTop * Math.min(1, Math.max(0, nextSliderValue / 1000));

    containerRef.current.scrollTo({
      top: targetTop,
      behavior: 'auto'
    });
  };

  useEffect(() => {
    if (!chromeVisible) {
      setSettingsOpen(false);
    }
  }, [chromeVisible]);

  return (
    <div className="reader-shell">
      <header className={`reader-toolbar ${chromeVisible ? 'is-visible' : ''}`}>
        <button className="icon-button" onClick={() => navigate('/')}>
          返回
        </button>
        <div className="reader-toolbar__title">
          <strong>{session.title?.displayTitle ?? session.book.displayTitle}</strong>
          <span>
            {session.title ? `${session.book.displayTitle} · ` : ''}第 {currentPage} / {totalPages} 页
          </span>
        </div>
        <div className="reader-toolbar__actions">
          <StatusBadge status={session.book.availabilityStatus} />
          <button className="icon-button" onClick={onOpenMore}>
            •••
          </button>
        </div>
      </header>

      <div ref={containerRef} className="reader-viewport" onClick={handleViewportTap}>
        {loadState === 'loading' ? <div className="reader-inline-message">正在规划页面分段并准备渲染...</div> : null}
        {loadError ? (
          <div className="reader-inline-message reader-inline-message--stacked">
            <span>{loadError}</span>
            <button className="action-button" onClick={() => setLoadAttempt((value) => value + 1)}>
              重试加载
            </button>
          </div>
        ) : null}

        {layout && pdf ? (
          <div className="reader-document" style={{ minHeight: `${layout.totalHeight}px` }}>
            {layout.segments.map((segment) => (
              <RenderedSegment
                key={segment.id}
                pdf={pdf}
                segment={segment}
                renderMode={renderWindow ? getSegmentRenderMode(renderWindow, segment.order) : 'cold'}
                showPageSeparators={settings.showPageSeparators}
                reportRenderedRef={reportRenderedRef}
              />
            ))}
          </div>
        ) : null}
      </div>

      <footer className={`reader-statusbar ${chromeVisible ? 'is-visible' : ''}`}>
        <label className="reader-progress">
          <span>进度</span>
          <input
            type="range"
            min={0}
            max={1000}
            step={1}
            value={sliderValue}
            onChange={(event) => handleProgressJump(Number(event.target.value))}
          />
        </label>
        <span className="reader-statusbar__summary">
          {session.book.displayTitle} · 已读 {progressPercent}%
        </span>
        <div className="reader-statusbar__actions">
          <button className="icon-button" onClick={onOpenPrevChapter} disabled={!hasPrevChapter || isChapterSwitching}>
            上一章
          </button>
          <button className="icon-button" onClick={onOpenChapterList} disabled={isChapterSwitching}>
            章节列表
          </button>
          <button className="icon-button" onClick={onOpenNextChapter} disabled={!hasNextChapter || isChapterSwitching}>
            下一章
          </button>
          <button className="icon-button" onClick={() => setSettingsOpen((value) => !value)}>
            阅读设置
          </button>
        </div>
      </footer>

      {settingsOpen ? (
        <section className={`reader-settings-panel ${chromeVisible ? 'is-visible' : ''}`}>
          <div className="reader-settings-panel__row">
            <div>
              <strong>点按步进</strong>
              <p className="muted-text">关闭后，中上中下区域都只用于切换菜单。</p>
            </div>
            <button
              className={`toggle-pill ${settings.tapStepEnabled ? 'is-active' : ''}`}
              onClick={() => onSettingsChange({ tapStepEnabled: !settings.tapStepEnabled })}
            >
              {settings.tapStepEnabled ? '开启' : '关闭'}
            </button>
          </div>

          <label className="reader-settings-panel__row reader-settings-panel__slider">
            <div>
              <strong>步进距离</strong>
              <p className="muted-text">当前约为视口高度的 {Math.round(settings.tapStepRatio * 100)}%</p>
            </div>
            <input
              type="range"
              min={0.6}
              max={1.1}
              step={0.05}
              value={settings.tapStepRatio}
              onChange={(event) => onSettingsChange({ tapStepRatio: Number(event.target.value) })}
            />
          </label>

          <div className="reader-settings-panel__row">
            <div>
              <strong>页面分隔细线</strong>
              <p className="muted-text">连续画面默认只保留极淡细线。</p>
            </div>
            <button
              className={`toggle-pill ${settings.showPageSeparators ? 'is-active' : ''}`}
              onClick={() => onSettingsChange({ showPageSeparators: !settings.showPageSeparators })}
            >
              {settings.showPageSeparators ? '显示' : '隐藏'}
            </button>
          </div>

          <p className="reader-settings-panel__meta">
            热区 {hotCount} 段 · 温区 {warmCount} 段 · 当前段 {currentSegment} ·{' '}
            {lastRenderMetric
              ? `上次渲染 ${lastRenderMetric.durationMs}ms · x${lastRenderMetric.qualityScale}`
              : loadDurationMs
                ? `首开 ${loadDurationMs}ms`
                : '正在计算布局'}
          </p>
        </section>
      ) : null}
    </div>
  );
}

function ReaderStateBlock({ children }: { children: ReactNode }) {
  return <main className="reader-state-block">{children}</main>;
}

function ReaderSheet({
  title,
  subtitle,
  variant = 'default',
  onClose,
  children
}: {
  title: string;
  subtitle?: string;
  variant?: 'default' | 'half' | 'half-wide';
  onClose: () => void;
  children: ReactNode;
}) {
  const sheetClass =
    variant === 'half-wide'
      ? 'bottom-sheet bottom-sheet--half bottom-sheet--half-wide'
      : variant === 'half'
        ? 'bottom-sheet bottom-sheet--half'
        : 'bottom-sheet';

  return (
    <div className="overlay-shell" role="presentation" onClick={onClose}>
      <section
        className={sheetClass}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="bottom-sheet__grabber" />
        <div className="bottom-sheet__header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="muted-text">{subtitle}</p> : null}
          </div>
          <button className="icon-button" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="bottom-sheet__content">{children}</div>
      </section>
    </div>
  );
}

export function ReaderPage() {
  const navigate = useNavigate();
  const { bookId } = useParams();
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const chapterCoverInputRef = useRef<HTMLInputElement | null>(null);
  const [session, setSession] = useState<ReaderSession | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [settings, setSettings] = useState<ReaderSettings>(() => loadReaderSettings());
  const [chromeVisible, setChromeVisible] = useState(true);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [isSwitchingChapter, setIsSwitchingChapter] = useState(false);
  const [relinkTargetBookId, setRelinkTargetBookId] = useState<string | null>(null);
  const [pendingChapterCoverId, setPendingChapterCoverId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [chapterEntries, setChapterEntries] = useState<BookWithProgress[]>([]);
  const [chapterSheetOpen, setChapterSheetOpen] = useState(false);
  const [editingChapter, setEditingChapter] = useState<BookWithProgress | null>(null);
  const [chapterDraft, setChapterDraft] = useState('');
  const [removingChapter, setRemovingChapter] = useState<Pick<BookWithProgress, 'bookId' | 'displayTitle'> | null>(null);

  const loadSession = async (nextBookId: string) => {
    const nextSession = await libraryService.getReaderSession(nextBookId);
    setSession(nextSession);
    setZoomScale(nextSession?.progress?.zoomScale ?? 1);
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!bookId) {
        return;
      }

      const nextSession = await libraryService.getReaderSession(bookId);

      if (!cancelled) {
        setSession(nextSession);
        setZoomScale(nextSession?.progress?.zoomScale ?? 1);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  useEffect(() => {
    setIsSwitchingChapter(false);
    setRelinkTargetBookId(bookId ?? null);
  }, [bookId]);

  useEffect(() => {
    window.localStorage.setItem(READER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    let cancelled = false;

    const loadChapters = async () => {
      if (!session?.title) {
        setChapterEntries([]);
        return;
      }

      const entries = await libraryService.listTitleChapters(session.title.titleId);
      if (!cancelled) {
        setChapterEntries(entries);
      }
    };

    void loadChapters();

    return () => {
      cancelled = true;
    };
  }, [session?.title?.titleId]);

  useEffect(() => {
    if (!bookId) {
      return;
    }

    let cancelled = false;

    const syncReaderState = async () => {
      const nextSession = await libraryService.getReaderSession(bookId);
      if (cancelled) {
        return;
      }

      setSession(nextSession);

      if (!chapterSheetOpen || !nextSession?.title?.titleId) {
        return;
      }

      const entries = await libraryService.listTitleChapters(nextSession.title.titleId);
      if (!cancelled) {
        setChapterEntries(entries);
      }
    };

    const unsubscribe = subscribeLibraryChanged(() => {
      void syncReaderState();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bookId, chapterSheetOpen]);

  useEffect(() => {
    if (!chromeVisible) {
      return;
    }

    const timer = window.setTimeout(() => {
      setChromeVisible(false);
    }, 2200);
    return () => window.clearTimeout(timer);
  }, [chromeVisible, session?.book.bookId]);

  const refreshChapterEntries = async (titleId: string | undefined) => {
    if (!titleId) {
      setChapterEntries([]);
      return;
    }

    setChapterEntries(await libraryService.listTitleChapters(titleId));
  };

  const handleRelink = async (files: FileList | null) => {
    const file = files?.[0];
    const targetBookId = relinkTargetBookId ?? bookId;

    if (!file || !targetBookId) {
      return;
    }

    try {
      const book = await libraryService.relinkLocalFile(targetBookId, file);
      setPageMessage(`已恢复 ${book.displayTitle}`);
      const currentOpenBookId = session?.book.bookId ?? book.bookId;
      if (book.bookId === currentOpenBookId) {
        await loadSession(book.bookId);
      } else {
        await loadSession(currentOpenBookId);
      }
      await refreshChapterEntries(session?.title?.titleId);
      setChromeVisible(true);
    } catch (error) {
      setPageMessage(error instanceof Error ? error.message : '重关联失败');
    } finally {
      setRelinkTargetBookId(bookId ?? null);
    }
  };

  const handleRemoteRetry = async (sourceInstanceId?: string) => {
    if (!session) {
      return;
    }

    const targetSourceInstanceId = sourceInstanceId ?? session.book.sourceInstanceId;
    setIsRecovering(true);

    try {
      const result = await libraryService.refreshRemoteSource(targetSourceInstanceId);
      await loadSession(session.book.bookId);
      await refreshChapterEntries(session.title?.titleId);
      setPageMessage(
        result.validation.status === 'ready'
          ? `已重新连接 ${result.source.name}`
          : result.validation.reason ?? '书源仍不可用'
      );
    } catch (error) {
      setPageMessage(error instanceof Error ? error.message : '重试连接失败');
    } finally {
      setIsRecovering(false);
    }
  };

  const handleChapterCover = async (files: FileList | null) => {
    const file = files?.[0];
    const targetBookId = pendingChapterCoverId ?? session?.book.bookId;

    if (!file || !session || !targetBookId) {
      return;
    }

    try {
      await libraryService.setBookCoverFile(targetBookId, file);
      await loadSession(session.book.bookId);
      await refreshChapterEntries(session.title?.titleId);
      setPageMessage('章节封面已更新');
    } catch (error) {
      setPageMessage(error instanceof Error ? error.message : '更新章节封面失败');
    } finally {
      setPendingChapterCoverId(null);
    }
  };

  const openChapterSheet = async () => {
    if (!session?.title) {
      return;
    }

    await refreshChapterEntries(session.title.titleId);
    setChapterSheetOpen(true);
    setMoreOpen(false);
  };

  const openChapterById = async (nextBookId: string) => {
    if (nextBookId === session?.book.bookId) {
      return;
    }

    setIsSwitchingChapter(true);
    setMoreOpen(false);
    setChapterSheetOpen(false);
    setChromeVisible(true);
    navigate(`/reader/${nextBookId}`);
  };

  const handleChapterPrimaryAction = async (chapter: BookWithProgress) => {
    if (chapter.bookId === session?.book.bookId && chapter.availabilityStatus === 'available') {
      return;
    }

    if (chapter.availabilityStatus === 'available') {
      await openChapterById(chapter.bookId);
      return;
    }

    if (chapter.sourceType === 'remote_url') {
      await handleRemoteRetry(chapter.sourceInstanceId);
      return;
    }

    setRelinkTargetBookId(chapter.bookId);
    relinkInputRef.current?.click();
  };

  const handleRemoveChapter = async (chapter: Pick<BookWithProgress, 'bookId' | 'displayTitle'>) => {
    await libraryService.removeBook(chapter.bookId);
    if (chapter.bookId === session?.book.bookId) {
      navigate('/');
      return;
    }

    await refreshChapterEntries(session?.title?.titleId);
    setPageMessage('章节已移除');
  };

  const confirmRemoveChapter = async () => {
    if (!removingChapter) {
      return;
    }

    const target = removingChapter;
    setRemovingChapter(null);
    await handleRemoveChapter(target);
  };

  if (!bookId) {
    return (
      <ReaderStateBlock>
        <h1>阅读目标不存在</h1>
        <Link className="action-button action-button--primary" to="/">
          返回首页
        </Link>
      </ReaderStateBlock>
    );
  }

  if (!session) {
    return (
      <ReaderStateBlock>
        <h1>正在准备阅读器...</h1>
      </ReaderStateBlock>
    );
  }

  const isRemoteUnavailable =
    session.book.availabilityStatus !== 'available' && session.book.sourceType === 'remote_url';
  const relinkHint =
    session.book.availabilityStatus !== 'available'
      ? session.book.availabilityReason ??
        (isRemoteUnavailable ? '当前需重新连接远程书源。' : '当前需重新选择原文件。')
      : null;
  const currentChapterIndex = chapterEntries.findIndex((entry) => entry.bookId === session.book.bookId);
  const previousChapter =
    currentChapterIndex >= 0 && currentChapterIndex < chapterEntries.length - 1
      ? chapterEntries[currentChapterIndex + 1]
      : null;
  const nextChapter = currentChapterIndex > 0 ? chapterEntries[currentChapterIndex - 1] : null;
  const duplicateHintMap = buildDuplicateChapterHintMap(chapterEntries);

  return (
    <>
      <input
        ref={relinkInputRef}
        className="visually-hidden"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          void handleRelink(event.target.files);
          event.currentTarget.value = '';
        }}
      />
      <input
        ref={chapterCoverInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        onChange={(event) => {
          void handleChapterCover(event.target.files);
          event.currentTarget.value = '';
        }}
      />

      {session.book.availabilityStatus !== 'available' ? (
        <ReaderStateBlock>
          <StatusBadge status={session.book.availabilityStatus} />
          <h1>{session.book.displayTitle}</h1>
          <p>{relinkHint}</p>
          {pageMessage ? <p className="inline-message">{pageMessage}</p> : null}
          <div className="button-row">
            {isRemoteUnavailable ? (
              <button className="action-button action-button--primary" onClick={() => void handleRemoteRetry()} disabled={isRecovering}>
                {isRecovering ? '正在重试...' : '重试连接书源'}
              </button>
            ) : (
              <button
                className="action-button action-button--primary"
                onClick={() => {
                  setRelinkTargetBookId(session.book.bookId);
                  relinkInputRef.current?.click();
                }}
              >
                重新选择原文件
              </button>
            )}
            <Link className="action-button" to="/">
              返回首页
            </Link>
          </div>
        </ReaderStateBlock>
      ) : (
        <>
          {pageMessage ? <p className="reader-floating-message">{pageMessage}</p> : null}
          <ReaderViewport
            session={session}
            chromeVisible={chromeVisible}
            zoomScale={zoomScale}
            settings={settings}
            onToggleChrome={() => setChromeVisible((value) => !value)}
            onSettingsChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
            onOpenMore={() => {
              setMoreOpen(true);
              setChromeVisible(true);
            }}
            onOpenChapterList={() => void openChapterSheet()}
            onOpenPrevChapter={() => void openChapterById(previousChapter?.bookId ?? session.book.bookId)}
            onOpenNextChapter={() => void openChapterById(nextChapter?.bookId ?? session.book.bookId)}
            hasPrevChapter={Boolean(previousChapter)}
            hasNextChapter={Boolean(nextChapter)}
            isChapterSwitching={isSwitchingChapter}
          />
        </>
      )}

      {moreOpen && session.book.availabilityStatus === 'available' ? (
        <ReaderSheet title={session.book.displayTitle} subtitle={session.title?.displayTitle} onClose={() => setMoreOpen(false)}>
          <div className="stack-actions">
            <button className="sheet-action" onClick={() => void openChapterSheet()}>
              打开章节列表
            </button>
            <button
              className="sheet-action"
              onClick={() => {
                setEditingChapter({ ...session.book, progress: session.progress });
                setChapterDraft(session.book.displayTitle);
                setMoreOpen(false);
              }}
            >
              修改章节名
            </button>
            <button
              className="sheet-action"
              onClick={() => {
                setPendingChapterCoverId(session.book.bookId);
                chapterCoverInputRef.current?.click();
                setMoreOpen(false);
              }}
            >
              修改章节封面
            </button>
            <button
              className="sheet-action"
              onClick={() => {
                if (session.book.sourceType === 'remote_url') {
                  void handleRemoteRetry();
                } else {
                  setRelinkTargetBookId(session.book.bookId);
                  relinkInputRef.current?.click();
                }
                setMoreOpen(false);
              }}
            >
              {session.book.sourceType === 'remote_url' ? '重试连接来源' : '重新选择原文件'}
            </button>
            <button
              className="sheet-action is-danger"
              onClick={() => {
                setMoreOpen(false);
                setRemovingChapter(session.book);
              }}
            >
              从作品中移除本章
            </button>
          </div>
        </ReaderSheet>
      ) : null}

      {chapterSheetOpen && session.title ? (
        <ReaderSheet title={session.title.displayTitle} subtitle="章节列表" variant="half-wide" onClose={() => setChapterSheetOpen(false)}>
          <div className="chapter-list">
            {chapterEntries.map((chapter) => {
              const duplicateHint = duplicateHintMap.get(chapter.bookId);

              return (
                <article key={chapter.bookId} className={`chapter-row ${chapter.bookId === session.book.bookId ? 'is-current' : ''}`}>
                  <div className="chapter-row__cover">
                    <CoverImage bookId={chapter.bookId} title={chapter.displayTitle} coverRef={chapter.coverRef} />
                  </div>
                  <div className="chapter-row__meta">
                    <strong>{chapter.displayTitle}</strong>
                    <p className="muted-text">
                      {chapter.progress ? formatProgressSummary(chapter.progress) : '未开始'} ·{' '}
                      {chapter.availabilityStatus === 'available' ? '可打开' : chapter.availabilityReason ?? '不可用'}
                    </p>
                    {duplicateHint ? (
                      <p className="chapter-row__duplicate">
                        <span className="meta-chip">重复内容</span>
                        <span className="muted-text">
                          与《{duplicateHint.matchedChapterName}》({duplicateHint.matchedFileName}) 重复
                        </span>
                      </p>
                    ) : null}
                  </div>
                  <div className="chapter-row__text-actions">
                    <button
                      className="text-action-button"
                      onClick={() => void handleChapterPrimaryAction(chapter)}
                      disabled={isRecovering}
                    >
                      {chapter.bookId === session.book.bookId
                        ? '当前章节'
                        : chapter.availabilityStatus === 'available'
                          ? '打开'
                          : '修复'}
                    </button>
                    <button
                      className="text-action-button"
                      onClick={() => {
                        setEditingChapter(chapter);
                        setChapterDraft(chapter.displayTitle);
                      }}
                    >
                      改名
                    </button>
                    <button
                      className="text-action-button"
                      onClick={() => {
                        setPendingChapterCoverId(chapter.bookId);
                        chapterCoverInputRef.current?.click();
                      }}
                    >
                      封面
                    </button>
                    <button
                      className="text-action-button is-danger"
                      onClick={() => {
                        setRemovingChapter(chapter);
                      }}
                    >
                      移除
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </ReaderSheet>
      ) : null}

      {editingChapter ? (
        <ReaderSheet title="修改章节名" onClose={() => setEditingChapter(null)}>
          <label className="field">
            <span>章节名</span>
            <input value={chapterDraft} onChange={(event) => setChapterDraft(event.target.value)} />
          </label>
          <div className="button-row">
            <button
              className="action-button action-button--primary"
              onClick={() => {
                void libraryService.renameBook(editingChapter.bookId, chapterDraft).then(async () => {
                  await loadSession(session.book.bookId);
                  await refreshChapterEntries(session.title?.titleId);
                  setEditingChapter(null);
                  setPageMessage('章节名已更新');
                });
              }}
            >
              保存
            </button>
          </div>
        </ReaderSheet>
      ) : null}

      {removingChapter ? (
        <ReaderSheet title="移除章节" onClose={() => setRemovingChapter(null)}>
          <p className="muted-text">确认移除章节「{removingChapter.displayTitle}」吗？此操作不可撤销。</p>
          <div className="button-row">
            <button className="action-button" onClick={() => setRemovingChapter(null)}>
              取消
            </button>
            <button className="action-button action-button--primary" onClick={() => void confirmRemoveChapter()}>
              确认移除
            </button>
          </div>
        </ReaderSheet>
      ) : null}
    </>
  );
}
