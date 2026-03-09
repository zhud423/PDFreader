import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CoverImage } from '../components/CoverImage';
import { StatusBadge } from '../components/StatusBadge';
import type { BookWithProgress } from '../domain/book';
import { useInstallPrompt } from '../lib/platform/useInstallPrompt';
import { subscribeLibraryChanged } from '../services/libraryEvents';
import {
  libraryService,
  type HomeOverview,
  type ImportResult
} from '../services/libraryService';
import { formatProgressSummary, formatRelativeTime } from '../shared/utils/format';

interface HomeFeedback {
  summary: string;
  details: string[];
  tone: 'normal' | 'warning';
}

function buildImportFeedback(result: ImportResult): HomeFeedback {
  const addedCount = Math.max(0, result.imported.length - result.updatedExistingCount);
  const parts: string[] = [];

  if (addedCount > 0) {
    parts.push(`新增 ${addedCount} 本`);
  }

  if (result.updatedExistingCount > 0) {
    parts.push(`更新 ${result.updatedExistingCount} 本`);
  }

  if (result.failed.length > 0) {
    parts.push(`失败 ${result.failed.length} 本`);
  }

  return {
    summary: parts.join('，') || '没有可导入的 PDF',
    details: result.failed.map((item) => `${item.fileName}: ${item.reason}`),
    tone: result.failed.length > 0 ? 'warning' : 'normal'
  };
}

interface BookCardProps {
  book: BookWithProgress;
  actionLabel: string;
  description: string;
  onAction: (book: BookWithProgress) => void;
}

function BookCard({ book, actionLabel, description, onAction }: BookCardProps) {
  return (
    <article className="book-card">
      <CoverImage bookId={book.bookId} title={book.displayTitle} />
      <div className="book-card__body">
        <div className="book-card__heading">
          <h3>{book.displayTitle}</h3>
          <StatusBadge status={book.availabilityStatus} />
        </div>
        <p>{book.fileName}</p>
        <p>上次阅读：{formatRelativeTime(book.lastOpenedAt ?? book.updatedAt)}</p>
        <p>进度：{formatProgressSummary(book.progress)}</p>
        <p className="muted-text">{description}</p>
        <button className="action-button" onClick={() => onAction(book)}>
          {actionLabel}
        </button>
      </div>
    </article>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const installPrompt = useInstallPrompt();
  const singleInputRef = useRef<HTMLInputElement | null>(null);
  const multiInputRef = useRef<HTMLInputElement | null>(null);
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [feedback, setFeedback] = useState<HomeFeedback | null>(null);
  const [relinkBookId, setRelinkBookId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadOverview = async () => {
      const next = await libraryService.getHomeOverview();
      if (!cancelled) {
        setOverview(next);
      }
    };

    void libraryService.revalidateAllBooks().then(loadOverview);
    const unsubscribe = subscribeLibraryChanged(() => {
      void loadOverview();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleImport = async (files: FileList | null) => {
    const pickedFiles = Array.from(files ?? []);
    if (pickedFiles.length === 0) {
      return;
    }

    setIsImporting(true);
    setFeedback(null);
    const result = await libraryService.importLocalFiles(pickedFiles);
    setIsImporting(false);
    setFeedback(buildImportFeedback(result));

    const firstImported = result.imported.at(0);
    if (firstImported) {
      navigate(`/reader/${firstImported.bookId}`);
    }
  };

  const handleOpenBook = (book: BookWithProgress) => {
    if (book.availabilityStatus !== 'available') {
      setRelinkBookId(book.bookId);
      relinkInputRef.current?.click();
      return;
    }

    navigate(`/reader/${book.bookId}`);
  };

  const handleRelink = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !relinkBookId) {
      return;
    }

    try {
      const book = await libraryService.relinkLocalFile(relinkBookId, file);
      setFeedback({
        summary: `已恢复 ${book.displayTitle}`,
        details: [],
        tone: 'normal'
      });
      navigate(`/reader/${book.bookId}`);
    } catch (error) {
      setFeedback({
        summary: error instanceof Error ? error.message : '重关联失败',
        details: [],
        tone: 'warning'
      });
    } finally {
      setRelinkBookId(null);
    }
  };

  const handleInstall = async () => {
    const outcome = await installPrompt.promptInstall();

    if (outcome === 'accepted') {
      setFeedback({
        summary: '已触发安装流程',
        details: ['安装完成后，应用会以更接近原生 App 的方式启动。'],
        tone: 'normal'
      });
      return;
    }

    if (outcome === 'dismissed') {
      setFeedback({
        summary: '安装已取消',
        details: [],
        tone: 'warning'
      });
    }
  };

  const continueReading = overview?.continueReading ?? null;
  const availableBooks = overview?.availableBooks ?? [];
  const unavailableBooks = overview?.unavailableBooks ?? [];

  return (
    <main className="app-shell">
      <input
        ref={singleInputRef}
        className="visually-hidden"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          void handleImport(event.target.files);
          event.currentTarget.value = '';
        }}
      />
      <input
        ref={multiInputRef}
        className="visually-hidden"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        onChange={(event) => {
          void handleImport(event.target.files);
          event.currentTarget.value = '';
        }}
      />
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

      <section className="hero-panel">
        <div>
          <p className="eyebrow">© 2026 小宝专用. All rights reserved.</p>
          <h1>漫画阅读器</h1>
          <p className="hero-copy">
            专门用于小黄漫的长漫，竖向阅读
          </p>
          <div className="hero-actions">
            <button className="action-button action-button--primary" onClick={() => singleInputRef.current?.click()}>
              导入 PDF
            </button>
            <button className="action-button" onClick={() => multiInputRef.current?.click()}>
              批量导入
            </button>
          </div>
        </div>
      </section>

      {installPrompt.mode !== 'hidden' ? (
        <section className="install-panel">
          <div>
            <p className="eyebrow">安装建议</p>
            <h2>把 PDFreader 放到主屏幕</h2>
            <p className="muted-text">
              {installPrompt.mode === 'browser'
                ? '安装后会使用独立窗口和更稳定的生命周期，适合当作日常阅读器。'
                : 'iPhone / iPad Safari 暂不弹系统安装窗。请点分享按钮，再选“添加到主屏幕”。'}
            </p>
          </div>
          <div className="button-row">
            {installPrompt.mode === 'browser' ? (
              <button className="action-button action-button--primary" onClick={() => void handleInstall()}>
                安装应用
              </button>
            ) : null}
            <button className="action-button" onClick={() => installPrompt.dismiss()}>
              稍后再说
            </button>
          </div>
        </section>
      ) : null}

      {feedback ? (
        <section className={`feedback-panel ${feedback.tone === 'warning' ? 'is-warning' : ''}`}>
          <p>{feedback.summary}</p>
          {feedback.details.length > 0 ? (
            <ul className="feedback-panel__list">
              {feedback.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {isImporting ? <p className="inline-message">正在解析 PDF、截取封面并写入书库...</p> : null}

      <section className="content-block">
        <div className="section-heading">
          <h2>{continueReading?.progress ? '继续阅读' : '最近添加'}</h2>
          <span>首页首屏固定聚焦主阅读路径</span>
        </div>

        {continueReading ? (
          <article className="continue-card">
            <CoverImage bookId={continueReading.bookId} title={continueReading.displayTitle} />
            <div className="continue-card__body">
              <div className="continue-card__title-row">
                <h3>{continueReading.displayTitle}</h3>
                <StatusBadge status={continueReading.availabilityStatus} />
              </div>
              <p>上次阅读：{formatRelativeTime(continueReading.lastOpenedAt ?? continueReading.updatedAt)}</p>
              <p>进度：{formatProgressSummary(continueReading.progress)}</p>
              <p className="muted-text">
                {continueReading.availabilityStatus === 'available'
                  ? '来源仍可访问，可直接回到上次阅读位置。'
                  : continueReading.availabilityReason ?? '当前需重新选择原文件后继续阅读。'}
              </p>
              <div className="button-row">
                <button className="action-button action-button--primary" onClick={() => handleOpenBook(continueReading)}>
                  {continueReading.availabilityStatus === 'available' ? '继续阅读' : '重新选择文件'}
                </button>
                <button className="action-button" onClick={() => multiInputRef.current?.click()}>
                  再导入几本
                </button>
              </div>
            </div>
          </article>
        ) : (
          <article className="empty-panel">
            <h3>先导入第一本 PDF</h3>
            <p>当前书库为空。P1 先把“导入 -&gt; 阅读 -&gt; 继续阅读”闭环跑通。</p>
          </article>
        )}
      </section>

      <section className="content-block">
        <div className="section-heading">
          <h2>最近书籍</h2>
          <span>{availableBooks.length} 本可直接打开</span>
        </div>

        {availableBooks.length > 0 ? (
          <div className="book-grid">
            {availableBooks.map((book) => (
              <BookCard
                key={book.bookId}
                book={book}
                actionLabel="打开阅读器"
                description="当前会话内仍保留文件访问能力，可直接恢复阅读。"
                onAction={handleOpenBook}
              />
            ))}
          </div>
        ) : (
          <article className="empty-panel">
            <h3>当前没有可直接打开的条目</h3>
            <p>如果你刚刷新过页面，这是预期行为。P1 不保存 PDF 副本，只保留元数据、封面和进度。</p>
          </article>
        )}
      </section>

      {unavailableBooks.length > 0 ? (
        <section className="content-block">
          <div className="section-heading">
            <h2>需要重新选择文件</h2>
            <span>{unavailableBooks.length} 本</span>
          </div>

          <div className="book-grid">
            {unavailableBooks.map((book) => (
              <BookCard
                key={book.bookId}
                book={book}
                actionLabel="重新选择文件"
                description={book.availabilityReason ?? '来源当前不可用，需重新关联原文件。'}
                onAction={handleOpenBook}
              />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
