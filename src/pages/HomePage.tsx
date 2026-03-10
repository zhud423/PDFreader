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
  type ImportResult,
  type RemoteSourceSyncResult,
  type SourceSummary
} from '../services/libraryService';
import {
  formatProgressSummary,
  formatRelativeTime,
  formatSourceStatusLabel
} from '../shared/utils/format';

interface HomeFeedback {
  summary: string;
  details: string[];
  tone: 'normal' | 'warning';
}

interface SourceDraft {
  name: string;
  baseUrl: string;
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

function buildRemoteSourceFeedback(result: RemoteSourceSyncResult): HomeFeedback {
  if (result.validation.status !== 'ready') {
    return {
      summary: `${result.source.name} 已保存，但当前不可用`,
      details: [result.validation.reason ?? '请确认局域网地址、HTTPS 配置和 library.json 是否可访问。'],
      tone: 'warning'
    };
  }

  const details = [
    `同步书籍 ${result.totalBooks} 本`,
    `新增 ${result.importedCount} 本`,
    `更新 ${result.updatedCount} 本`
  ];

  if (result.missingCount > 0) {
    details.push(`标记失效 ${result.missingCount} 本`);
  }

  return {
    summary: `${result.source.name} 已同步`,
    details,
    tone: 'normal'
  };
}

function getBookDescription(book: BookWithProgress): string {
  if (book.availabilityStatus !== 'available') {
    if (book.sourceType === 'remote_url') {
      return book.availabilityReason ?? '远程书源当前不可用，可重试同步。';
    }

    return book.availabilityReason ?? '来源当前不可用，需重新关联原文件。';
  }

  if (book.sourceType === 'remote_url') {
    return '来自局域网 URL 书源，可直接通过远程地址打开。';
  }

  return '当前会话内仍保留文件访问能力，可直接恢复阅读。';
}

function getBookActionLabel(book: BookWithProgress): string {
  if (book.availabilityStatus === 'available') {
    return '打开阅读器';
  }

  return book.sourceType === 'remote_url' ? '重试连接' : '重新选择文件';
}

interface BookCardProps {
  book: BookWithProgress;
  onAction: (book: BookWithProgress) => void | Promise<void>;
}

function BookCard({ book, onAction }: BookCardProps) {
  return (
    <article className="book-card">
      <CoverImage bookId={book.bookId} title={book.displayTitle} coverRef={book.coverRef} />
      <div className="book-card__body">
        <div className="book-card__heading">
          <h3>{book.displayTitle}</h3>
          <StatusBadge status={book.availabilityStatus} />
        </div>
        <p>{book.fileName}</p>
        <p>上次阅读：{formatRelativeTime(book.lastOpenedAt ?? book.updatedAt)}</p>
        <p>进度：{formatProgressSummary(book.progress)}</p>
        <p className="muted-text">{getBookDescription(book)}</p>
        <button className="action-button" onClick={() => void onAction(book)}>
          {getBookActionLabel(book)}
        </button>
      </div>
    </article>
  );
}

interface SourceCardProps {
  source: SourceSummary;
  syncing: boolean;
  onRefresh: (source: SourceSummary) => void | Promise<void>;
}

function SourceCard({ source, syncing, onRefresh }: SourceCardProps) {
  return (
    <article className="source-card">
      <div className="source-card__header">
        <div>
          <h3>{source.name}</h3>
          <p className="muted-text">{source.baseUrl}</p>
        </div>
        <span className={`source-status-chip is-${source.status}`}>
          {formatSourceStatusLabel(source.status)}
        </span>
      </div>
      <div className="source-card__metrics">
        <span>{source.totalBooks} 本书</span>
        <span>{source.availableBooks} 本可读</span>
        <span>{source.unavailableBooks} 本不可用</span>
      </div>
      <p className="muted-text">最近同步：{formatRelativeTime(source.updatedAt)}</p>
      <div className="button-row">
        <button className="action-button" onClick={() => void onRefresh(source)} disabled={syncing}>
          {syncing ? '正在同步...' : '立即同步'}
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
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>({ name: '', baseUrl: '' });
  const [syncingSourceId, setSyncingSourceId] = useState<string | null>(null);

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

  const handleRemoteSourceSubmit = async () => {
    if (!sourceDraft.baseUrl.trim()) {
      setFeedback({
        summary: '请先填写局域网书源 URL',
        details: ['示例：https://nas-home.example.com/comics'],
        tone: 'warning'
      });
      return;
    }

    setSyncingSourceId('new');
    setFeedback(null);

    try {
      const result = await libraryService.syncRemoteUrlSource(sourceDraft);
      setFeedback(buildRemoteSourceFeedback(result));
      if (result.validation.status === 'ready') {
        setSourceDraft({ name: '', baseUrl: '' });
      }
    } catch (error) {
      setFeedback({
        summary: error instanceof Error ? error.message : '添加远程书源失败',
        details: [],
        tone: 'warning'
      });
    } finally {
      setSyncingSourceId(null);
    }
  };

  const handleRefreshSource = async (source: SourceSummary) => {
    setSyncingSourceId(source.sourceInstanceId);
    setFeedback(null);

    try {
      const result = await libraryService.refreshRemoteSource(source.sourceInstanceId);
      setFeedback(buildRemoteSourceFeedback(result));
    } catch (error) {
      setFeedback({
        summary: error instanceof Error ? error.message : '刷新远程书源失败',
        details: [],
        tone: 'warning'
      });
    } finally {
      setSyncingSourceId(null);
    }
  };

  const handleBookAction = async (book: BookWithProgress) => {
    if (book.availabilityStatus === 'available') {
      navigate(`/reader/${book.bookId}`);
      return;
    }

    if (book.sourceType === 'remote_url') {
      setSyncingSourceId(book.sourceInstanceId);

      try {
        const result = await libraryService.refreshRemoteSource(book.sourceInstanceId);
        setFeedback(buildRemoteSourceFeedback(result));

        if (result.validation.status === 'ready') {
          navigate(`/reader/${book.bookId}`);
        }
      } catch (error) {
        setFeedback({
          summary: error instanceof Error ? error.message : '远程书源重试失败',
          details: [],
          tone: 'warning'
        });
      } finally {
        setSyncingSourceId(null);
      }
      return;
    }

    setRelinkBookId(book.bookId);
    relinkInputRef.current?.click();
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
  const remoteSources = (overview?.sourceSummaries ?? []).filter((source) => source.sourceType === 'remote_url');
  const unavailableTitle =
    unavailableBooks.some((book) => book.sourceType === 'remote_url') ? '当前不可用的条目' : '需要重新选择文件';

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
          <p className="hero-copy">专门用于小黄漫的长漫，竖向阅读</p>
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
          <h2>局域网 URL 书源</h2>
          <span>P2 开始接入远程 library.json</span>
        </div>

        <div className="source-form">
          <label className="field">
            <span>书源名称</span>
            <input
              value={sourceDraft.name}
              placeholder="例如：家里 NAS"
              onChange={(event) => setSourceDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="field field--wide">
            <span>书源 URL</span>
            <input
              value={sourceDraft.baseUrl}
              placeholder="https://nas-home.example.com/comics"
              onChange={(event) =>
                setSourceDraft((current) => ({ ...current, baseUrl: event.target.value }))
              }
            />
          </label>
          <button
            className="action-button action-button--primary"
            onClick={() => void handleRemoteSourceSubmit()}
            disabled={syncingSourceId === 'new'}
          >
            {syncingSourceId === 'new' ? '正在连接...' : '添加并同步'}
          </button>
        </div>

        <p className="muted-text">
          当前协议要求根目录可访问 library.json，其中每本书需声明 canonicalKey、pdfPath、页数和首页尺寸。公开测试时建议书源同时满足 HTTPS 和 CORS。
        </p>

        {remoteSources.length > 0 ? (
          <div className="source-grid">
            {remoteSources.map((source) => (
              <SourceCard
                key={source.sourceInstanceId}
                source={source}
                syncing={syncingSourceId === source.sourceInstanceId}
                onRefresh={handleRefreshSource}
              />
            ))}
          </div>
        ) : (
          <article className="empty-panel">
            <h3>还没有局域网书源</h3>
            <p>先添加一个可访问的 HTTPS 目录，之后首页会把远程书和本地书放在同一套书库模型里。</p>
          </article>
        )}
      </section>

      <section className="content-block">
        <div className="section-heading">
          <h2>{continueReading?.progress ? '继续阅读' : '最近添加'}</h2>
          <span>首页首屏固定聚焦主阅读路径</span>
        </div>

        {continueReading ? (
          <article className="continue-card">
            <CoverImage
              bookId={continueReading.bookId}
              title={continueReading.displayTitle}
              coverRef={continueReading.coverRef}
            />
            <div className="continue-card__body">
              <div className="continue-card__title-row">
                <h3>{continueReading.displayTitle}</h3>
                <StatusBadge status={continueReading.availabilityStatus} />
              </div>
              <p>上次阅读：{formatRelativeTime(continueReading.lastOpenedAt ?? continueReading.updatedAt)}</p>
              <p>进度：{formatProgressSummary(continueReading.progress)}</p>
              <p className="muted-text">{getBookDescription(continueReading)}</p>
              <div className="button-row">
                <button
                  className="action-button action-button--primary"
                  onClick={() => void handleBookAction(continueReading)}
                >
                  {continueReading.availabilityStatus === 'available'
                    ? '继续阅读'
                    : continueReading.sourceType === 'remote_url'
                      ? '重试连接'
                      : '重新选择文件'}
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
            <p>当前书库为空。P2 仍然保持“导入 / 同步 -&gt; 阅读 -&gt; 继续阅读”作为主闭环。</p>
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
              <BookCard key={book.bookId} book={book} onAction={handleBookAction} />
            ))}
          </div>
        ) : (
          <article className="empty-panel">
            <h3>当前没有可直接打开的条目</h3>
            <p>如果你刚刷新过页面，本地上传条目会失去会话句柄；远程 URL 书源同步成功后则可以直接继续打开。</p>
          </article>
        )}
      </section>

      {unavailableBooks.length > 0 ? (
        <section className="content-block">
          <div className="section-heading">
            <h2>{unavailableTitle}</h2>
            <span>{unavailableBooks.length} 本</span>
          </div>

          <div className="book-grid">
            {unavailableBooks.map((book) => (
              <BookCard key={book.bookId} book={book} onAction={handleBookAction} />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
