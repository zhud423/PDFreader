import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ProgressRecord } from '../domain/progress';
import { subscribePageLifecycle } from '../lib/platform/pageLifecycle';
import { getDocument, type PDFDocumentProxy } from '../lib/pdf/pdf';
import {
  buildReaderLayout,
  findSegmentForScroll,
  resolveProgressSegment,
  type ReaderLayout,
  type ReaderSegment
} from '../lib/reader/segmentPlanner';
import { StatusBadge } from '../components/StatusBadge';
import { libraryService, type ReaderSession } from '../services/libraryService';

interface RenderedSegmentProps {
  pdf: PDFDocumentProxy;
  segment: ReaderSegment;
  isActive: boolean;
  reportRenderedRef: MutableRefObject<(segmentId: string) => void>;
}

function isRenderingCancelledError(value: unknown): boolean {
  return value instanceof Error && value.name === 'RenderingCancelledException';
}

function RenderedSegment({
  pdf,
  segment,
  isActive,
  reportRenderedRef
}: RenderedSegmentProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderState, setRenderState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    if (!isActive) {
      const context = canvas.getContext('2d');
      context?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
      setRenderState('idle');
      setError(null);
      return;
    }

    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;

    const render = async () => {
      setRenderState('loading');
      const page = await pdf.getPage(segment.pageNumber);
      const devicePixelRatio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: segment.scale * devicePixelRatio });
      const translateY = Math.round(segment.offsetY * devicePixelRatio);
      canvas.width = Math.max(1, Math.round(segment.width * devicePixelRatio));
      canvas.height = Math.max(1, Math.round(segment.height * devicePixelRatio));
      canvas.style.width = `${Math.round(segment.width)}px`;
      canvas.style.height = `${Math.round(segment.height)}px`;
      const context = canvas.getContext('2d');

      if (!context) {
        throw new Error('无法创建分段渲染上下文。');
      }

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);

      renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: [1, 0, 0, 1, 0, -translateY]
      });
      await renderTask.promise;
      page.cleanup();

      if (!cancelled) {
        setRenderState('ready');
        setError(null);
        reportRenderedRef.current(segment.id);
      }
    };

    void render().catch((value: unknown) => {
      if (!cancelled && !isRenderingCancelledError(value)) {
        setRenderState('error');
        setError(value instanceof Error ? value.message : '分段渲染失败');
      }
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [
    isActive,
    pdf,
    reportRenderedRef,
    segment.height,
    segment.id,
    segment.offsetY,
    segment.pageNumber,
    segment.scale,
    segment.width
  ]);

  return (
    <section
      className="reader-segment-shell"
      style={{ height: `${segment.height + segment.gapBefore}px`, paddingTop: `${segment.gapBefore}px` }}
    >
      <div className="reader-segment-frame" style={{ width: `${segment.width}px`, height: `${segment.height}px` }}>
        {isActive && renderState !== 'ready' ? (
          <div className={`reader-segment-placeholder ${isActive ? 'is-loading' : ''}`} />
        ) : null}
        {isActive ? <canvas ref={canvasRef} className="reader-segment-canvas" /> : null}
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
  const reportRenderedRef = useRef<(segmentId: string) => void>(() => {});
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

  reportRenderedRef.current = (segmentId: string) => {
    if (renderedSegmentsRef.current.has(segmentId)) {
      return;
    }

    renderedSegmentsRef.current.add(segmentId);
    setRenderTick((value) => value + 1);
  };

  useEffect(() => {
    let cancelled = false;
    let activePdf: PDFDocumentProxy | null = null;

    const loadDocument = async () => {
      if (!session.data) {
        setLoadState('error');
        setLoadError('当前没有可用的 PDF 数据。');
        return;
      }

      const task = getDocument({ data: session.data.slice(0) });
      const loadedPdf = await task.promise;
      activePdf = loadedPdf;

      if (cancelled) {
        await loadedPdf.destroy();
        return;
      }

      setPdf(loadedPdf);
      setLoadError(null);
    };

    setLoadState('loading');
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
  }, [session.data]);

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

    const initialSegment = resolveProgressSegment(layout, session.progress);
    if (!initialSegment) {
      return;
    }

    lastProgressRef.current = {
      bookId: session.book.bookId,
      pageIndex: initialSegment.pageIndex,
      segmentIndex: initialSegment.segmentIndex,
      scrollOffsetWithinSegment: session.progress?.scrollOffsetWithinSegment ?? 0,
      zoomScale,
      viewportWidth: viewportSnapshot.width,
      viewportHeight: viewportSnapshot.height,
      restoreStrategyVersion: 1,
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
        restoreStrategyVersion: 1,
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
      zoomScale
    };
  }, [zoomScale]);

  useEffect(() => {
    renderedSegmentsRef.current.clear();
    restoredRef.current = false;
    setRenderTick(0);
  }, [layout]);

  useEffect(() => {
    if (!layout || restoredRef.current) {
      return;
    }

    const targetSegment = resolveProgressSegment(layout, session.progress);
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

    const targetTop = targetSegment.top + (session.progress?.scrollOffsetWithinSegment ?? 0);
    container.scrollTo({
      top: targetTop,
      behavior: 'auto'
    });
    setViewportSnapshot((previous) => ({ ...previous, scrollTop: targetTop }));
    setCurrentPage(targetSegment.pageNumber);
    setCurrentSegment(targetSegment.segmentIndex + 1);
    restoredRef.current = true;
  }, [layout, renderTick, session.progress]);

  useEffect(() => {
    void libraryService.markBookOpened(session.book.bookId);
  }, [session.book.bookId]);

  if (session.book.availabilityStatus !== 'available' || !session.data) {
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

  const activeTop = viewportSnapshot.scrollTop - viewportSnapshot.height * 1.25;
  const activeBottom = viewportSnapshot.scrollTop + viewportSnapshot.height * 2.5;
  const totalPages = layout?.pages.length ?? session.book.pageCount;

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

      <div
        ref={containerRef}
        className="reader-viewport"
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('button,a,input')) {
            return;
          }

          onToggleChrome();
        }}
      >
        {loadState === 'loading' ? <div className="reader-inline-message">正在规划页面分段并准备渲染...</div> : null}
        {loadError ? <div className="reader-inline-message">{loadError}</div> : null}

        {layout ? (
          <div className="reader-document" style={{ minHeight: `${layout.totalHeight}px` }}>
            {layout.segments.map((segment) => {
              const isActive =
                segment.top + segment.height >= activeTop && segment.top <= activeBottom;

              return (
                <RenderedSegment
                  key={segment.id}
                  pdf={pdf!}
                  segment={segment}
                  isActive={isActive}
                  reportRenderedRef={reportRenderedRef}
                />
              );
            })}
          </div>
        ) : null}
      </div>

      <footer className={`reader-statusbar ${chromeVisible ? 'is-visible' : ''}`}>
        <span>分段渲染已启用</span>
        <span>{layout ? `目标段高 ${Math.round(layout.segmentTargetHeight)}px` : '正在计算布局'}</span>
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

  const relinkHint =
    session && session.book.availabilityStatus !== 'available'
      ? session.book.availabilityReason ?? '当前需重新选择原文件。'
      : null;

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
            <button className="action-button action-button--primary" onClick={() => relinkInputRef.current?.click()}>
              重新选择原文件
            </button>
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
