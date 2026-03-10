import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ProgressRecord } from '../domain/progress';
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

interface RenderReport {
  segmentId: string;
  durationMs: number;
  qualityScale: number;
}

const TAP_STEP_RATIO = 0.9;
const TAP_ZONE_RATIO = 1 / 3;

interface RenderedSegmentProps {
  pdf: PDFDocumentProxy;
  segment: ReaderSegment;
  renderMode: ReaderSegmentRenderMode;
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
      className={`reader-segment-shell ${segment.pageNumber > 1 && segment.segmentIndex === 0 ? 'is-page-start' : ''}`}
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
  onToggleChrome: () => void;
  onZoomChange: (next: number) => void;
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

function ReaderViewport({
  session,
  chromeVisible,
  zoomScale,
  onToggleChrome,
  onZoomChange
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

  const flushProgress = async () => {
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

    if (offsetY <= topZoneMax) {
      container.scrollBy({
        top: -Math.max(180, Math.round(rect.height * TAP_STEP_RATIO)),
        behavior: 'smooth'
      });
      return;
    }

    if (offsetY >= bottomZoneMin) {
      container.scrollBy({
        top: Math.max(180, Math.round(rect.height * TAP_STEP_RATIO)),
        behavior: 'smooth'
      });
      return;
    }

    onToggleChrome();
  };

  return (
    <div className="reader-shell">
      <header className={`reader-toolbar ${chromeVisible ? 'is-visible' : ''}`}>
        <button className="icon-button" onClick={() => navigate('/')}>
          返回
        </button>
        <div className="reader-toolbar__title">
          <strong>{session.book.displayTitle}</strong>
          <span>
            第 {currentPage} / {totalPages} 页 · 当前段 {currentSegment}
          </span>
        </div>
        <div className="reader-toolbar__actions">
          <button className="icon-button" onClick={() => onZoomChange(Math.max(0.9, zoomScale - 0.1))}>
            缩小
          </button>
          <button className="icon-button" onClick={() => onZoomChange(Math.min(2.2, zoomScale + 0.1))}>
            放大
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
                reportRenderedRef={reportRenderedRef}
              />
            ))}
          </div>
        ) : null}
      </div>

      <footer className={`reader-statusbar ${chromeVisible ? 'is-visible' : ''}`}>
        <span>{`热区 ${hotCount} 段 · 温区 ${warmCount} 段`}</span>
        <span>
          {lastRenderMetric
            ? `上次渲染 ${lastRenderMetric.durationMs}ms · x${lastRenderMetric.qualityScale}`
            : '等待首段渲染'}
        </span>
        <span>{loadDurationMs ? `首开 ${loadDurationMs}ms` : '正在计算布局'}</span>
      </footer>
    </div>
  );
}

function ReaderStateBlock({ children }: { children: ReactNode }) {
  return <main className="reader-state-block">{children}</main>;
}

export function ReaderPage() {
  const { bookId } = useParams();
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const [session, setSession] = useState<ReaderSession | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);

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
    if (!chromeVisible) {
      return;
    }

    const timer = window.setTimeout(() => {
      setChromeVisible(false);
    }, 2200);
    return () => window.clearTimeout(timer);
  }, [chromeVisible, session?.book.bookId]);

  const handleRelink = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !bookId) {
      return;
    }

    try {
      const book = await libraryService.relinkLocalFile(bookId, file);
      setPageMessage(`已恢复 ${book.displayTitle}`);
      const nextSession = await libraryService.getReaderSession(book.bookId);
      setSession(nextSession);
      setZoomScale(nextSession?.progress?.zoomScale ?? 1);
      setChromeVisible(true);
    } catch (error) {
      setPageMessage(error instanceof Error ? error.message : '重关联失败');
    }
  };

  const handleRemoteRetry = async () => {
    if (!session || session.book.sourceType !== 'remote_url') {
      return;
    }

    setIsRecovering(true);

    try {
      const result = await libraryService.refreshRemoteSource(session.book.sourceInstanceId);
      const nextSession = await libraryService.getReaderSession(session.book.bookId);
      setSession(nextSession);
      setZoomScale(nextSession?.progress?.zoomScale ?? 1);
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
              <button className="action-button action-button--primary" onClick={() => relinkInputRef.current?.click()}>
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
            onToggleChrome={() => setChromeVisible((value) => !value)}
            onZoomChange={(next) => {
              setZoomScale(Number(next.toFixed(2)));
              setChromeVisible(true);
            }}
          />
        </>
      )}
    </>
  );
}
