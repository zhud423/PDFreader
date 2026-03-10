import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CoverImage } from '../components/CoverImage';
import { StatusBadge } from '../components/StatusBadge';
import type { BookWithProgress } from '../domain/book';
import { subscribeLibraryChanged } from '../services/libraryEvents';
import {
  libraryService,
  type HomeOverview,
  type RemoteSourceSyncResult,
  type TitleSummary
} from '../services/libraryService';
import { formatProgressSummary, formatRelativeTime } from '../shared/utils/format';

type SortOrder = 'lastOpened' | 'updated' | 'imported' | 'title';

interface HomeFeedback {
  summary: string;
  details: string[];
  tone: 'normal' | 'warning';
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
    `同步作品 ${result.totalBooks} 本`,
    `新增 ${result.importedCount} 章`,
    `更新 ${result.updatedCount} 章`
  ];

  if (result.missingCount > 0) {
    details.push(`标记失效 ${result.missingCount} 章`);
  }

  return {
    summary: `${result.source.name} 已同步`,
    details,
    tone: 'normal'
  };
}

function getTitleLeadChapter(title: TitleSummary): BookWithProgress | null {
  return title.continueReadingChapter ?? title.latestChapter ?? null;
}

function getTitleActionLabel(title: TitleSummary): string {
  const leadChapter = getTitleLeadChapter(title);
  if (!leadChapter) {
    return '查看章节';
  }

  if (leadChapter.availabilityStatus === 'available') {
    return title.continueReadingChapter ? '继续阅读' : '开始阅读';
  }

  return leadChapter.sourceType === 'remote_url' ? '修复来源' : '重新关联';
}

function isTitleRelinkRequired(title: TitleSummary): boolean {
  const leadChapter = getTitleLeadChapter(title);
  if (!leadChapter) {
    return false;
  }

  return leadChapter.availabilityStatus !== 'available' && leadChapter.sourceType !== 'remote_url';
}

function getTitleSourceLabel(title: TitleSummary): string {
  switch (title.sourceKind) {
    case 'remote':
      return '局域网';
    case 'mixed':
      return '混合';
    default:
      return '本地';
  }
}

function getTitleAvailabilityLabel(title: TitleSummary): string {
  switch (title.availability) {
    case 'unavailable':
      return '全部失效';
    case 'partial':
      return '部分缺失';
    default:
      return '可读';
  }
}

function getTitleReadingStateLabel(readingState: TitleSummary['readingState']): string {
  switch (readingState) {
    case 'finished':
      return '已读';
    case 'reading':
      return '在读';
    default:
      return '未标记';
  }
}

function getTitleProgressText(title: TitleSummary): string {
  if (!title.continueReadingChapter?.progress) {
    return '未开始';
  }

  return formatProgressSummary(title.continueReadingChapter.progress);
}

function sortTitles(entries: TitleSummary[], sortOrder: SortOrder): TitleSummary[] {
  const sorted = [...entries];

  sorted.sort((left, right) => {
    if (sortOrder === 'title') {
      return left.displayTitle.localeCompare(right.displayTitle, 'zh-CN', { numeric: true });
    }

    if (sortOrder === 'imported') {
      const leftImportedAt = left.latestChapter?.createdAt ?? left.updatedAt;
      const rightImportedAt = right.latestChapter?.createdAt ?? right.updatedAt;
      return rightImportedAt.localeCompare(leftImportedAt);
    }

    if (sortOrder === 'updated') {
      return right.updatedAt.localeCompare(left.updatedAt);
    }

    return (right.lastOpenedAt ?? '').localeCompare(left.lastOpenedAt ?? '');
  });

  return sorted;
}

function filterTitles(entries: TitleSummary[], searchQuery: string): TitleSummary[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();

  return entries.filter((title) => {
    if (!normalizedQuery) {
      return true;
    }

    const leadChapter = getTitleLeadChapter(title);
    const haystack = [title.displayTitle, leadChapter?.displayTitle ?? ''].join(' ').toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

interface TitleCardProps {
  title: TitleSummary;
  isRelinking: boolean;
  onOpen: (title: TitleSummary) => void | Promise<void>;
  onOpenMenu: (title: TitleSummary) => void;
}

function TitleCard({ title, isRelinking, onOpen, onOpenMenu }: TitleCardProps) {
  const leadChapter = getTitleLeadChapter(title);
  const coverBookId = title.coverBookId ?? leadChapter?.bookId ?? '';
  const actionLabel = isRelinking ? '关联中…' : getTitleActionLabel(title);
  const relinkHint = isRelinking
    ? '正在关联文件，请稍候…'
    : isTitleRelinkRequired(title)
      ? '首章失去关联，必须重新关联后才可以继续阅读'
      : null;

  return (
    <article className="library-title-card">
      <button className="library-title-card__cover" onClick={() => void onOpen(title)}>
        <CoverImage bookId={coverBookId} title={title.displayTitle} coverRef={leadChapter?.coverRef} />
      </button>

      <div className="library-title-card__body">
        <div className="library-title-card__topline">
          <div className="library-title-card__summary">
            <h3>{title.displayTitle}</h3>
            <p className="muted-text">
              {getTitleSourceLabel(title)} · {title.chapterCount} 章 · {getTitleAvailabilityLabel(title)}
            </p>
          </div>
          <div className="library-title-card__side">
            <div className="library-title-card__badges">
              {title.isFavorite ? <span className="meta-chip">收藏</span> : null}
              <span className="meta-chip">{getTitleReadingStateLabel(title.readingState)}</span>
              {leadChapter ? <StatusBadge status={leadChapter.availabilityStatus} /> : null}
            </div>
          </div>
        </div>

        <p>上次阅读：{title.continueReadingChapter?.displayTitle ?? '还没有进入章节'}</p>
        <p>进度：{getTitleProgressText(title)}</p>
        <p className="muted-text">最近活动：{formatRelativeTime(title.lastOpenedAt ?? title.updatedAt)}</p>
        <div className="library-title-card__action-stack">
          {relinkHint ? <p className="muted-text library-title-card__hint">{relinkHint}</p> : null}
          <div className="library-title-card__actions">
            <button
              className="action-button action-button--primary"
              onClick={() => void onOpen(title)}
              disabled={isRelinking}
            >
              {actionLabel}
            </button>
            <button
              className="icon-button"
              aria-label={`${title.displayTitle} 更多`}
              onClick={() => onOpenMenu(title)}
              disabled={isRelinking}
            >
              •••
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

interface SheetProps {
  title: string;
  subtitle?: string;
  variant?: 'default' | 'half' | 'half-wide';
  onClose: () => void;
  children: React.ReactNode;
}

function HomeSheet({ title, subtitle, variant = 'default', onClose, children }: SheetProps) {
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
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            关闭
          </button>
        </div>
        <div className="bottom-sheet__content">{children}</div>
      </section>
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const titleCoverInputRef = useRef<HTMLInputElement | null>(null);
  const chapterCoverInputRef = useRef<HTMLInputElement | null>(null);
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [feedback, setFeedback] = useState<HomeFeedback | null>(null);
  const [relinkBookId, setRelinkBookId] = useState<string | null>(null);
  const [relinkLoadingBookId, setRelinkLoadingBookId] = useState<string | null>(null);
  const [pendingTitleCoverId, setPendingTitleCoverId] = useState<string | null>(null);
  const [pendingChapterCoverId, setPendingChapterCoverId] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>('lastOpened');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const [titleMenu, setTitleMenu] = useState<TitleSummary | null>(null);
  const [chapterSheetTitle, setChapterSheetTitle] = useState<TitleSummary | null>(null);
  const [chapterEntries, setChapterEntries] = useState<BookWithProgress[]>([]);
  const [editingTitle, setEditingTitle] = useState<TitleSummary | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingChapter, setEditingChapter] = useState<BookWithProgress | null>(null);
  const [chapterDraft, setChapterDraft] = useState('');
  const [removingChapter, setRemovingChapter] = useState<BookWithProgress | null>(null);

  const loadOverview = async () => {
    const next = await libraryService.getHomeOverview();
    setOverview(next);
  };

  useEffect(() => {
    let cancelled = false;

    const guardedLoad = async () => {
      const next = await libraryService.getHomeOverview();
      if (!cancelled) {
        setOverview(next);
      }
    };

    void libraryService.revalidateAllBooks().then(guardedLoad);
    const unsubscribe = subscribeLibraryChanged(() => {
      void guardedLoad();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!chapterSheetTitle) {
      return;
    }

    let cancelled = false;

    const refreshChapterEntries = async () => {
      const entries = await libraryService.listTitleChapters(chapterSheetTitle.titleId);
      if (!cancelled) {
        setChapterEntries(entries);
      }
    };

    void refreshChapterEntries();
    const unsubscribe = subscribeLibraryChanged(() => {
      void refreshChapterEntries();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [chapterSheetTitle?.titleId]);

  const handleRelink = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !relinkBookId) {
      return;
    }

    const currentBookId = relinkBookId;
    setRelinkLoadingBookId(currentBookId);
    setFeedback({
      summary: '正在关联文件，请稍候…',
      details: [],
      tone: 'normal'
    });

    try {
      const book = await libraryService.relinkLocalFile(currentBookId, file);
      await loadOverview();
      setFeedback({
        summary: `${book.displayTitle} 关联成功，可继续阅读`,
        details: [],
        tone: 'normal'
      });
    } catch (error) {
      setFeedback({
        summary: error instanceof Error ? error.message : '重关联失败',
        details: [],
        tone: 'warning'
      });
    } finally {
      setRelinkBookId(null);
      setRelinkLoadingBookId(null);
    }
  };

  const handleBookAction = async (book: BookWithProgress) => {
    if (book.availabilityStatus === 'available') {
      navigate(`/reader/${book.bookId}`);
      return;
    }

    if (book.sourceType === 'remote_url') {
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
      }
      return;
    }

    setRelinkBookId(book.bookId);
    relinkInputRef.current?.click();
  };

  const handleTitleAction = async (title: TitleSummary) => {
    const leadChapter = getTitleLeadChapter(title);
    if (!leadChapter) {
      setFeedback({
        summary: '这个作品下还没有可打开的章节',
        details: [],
        tone: 'warning'
      });
      return;
    }

    await handleBookAction(leadChapter);
  };

  const openChapterSheet = async (title: TitleSummary) => {
    setChapterSheetTitle(title);
    setChapterEntries(await libraryService.listTitleChapters(title.titleId));
    setTitleMenu(null);
  };

  const refreshChapterSheet = async (titleId: string) => {
    setChapterEntries(await libraryService.listTitleChapters(titleId));
    await loadOverview();
  };

  const handleTitleCoverPick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !pendingTitleCoverId) {
      return;
    }

    try {
      await libraryService.setTitleCoverFile(pendingTitleCoverId, file);
      setFeedback({
        summary: '作品封面已更新',
        details: [],
        tone: 'normal'
      });
    } catch (error) {
      setFeedback({
        summary: error instanceof Error ? error.message : '更新作品封面失败',
        details: [],
        tone: 'warning'
      });
    } finally {
      setPendingTitleCoverId(null);
    }
  };

  const handleChapterCoverPick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !pendingChapterCoverId) {
      return;
    }

    try {
      await libraryService.setBookCoverFile(pendingChapterCoverId, file);
      if (chapterSheetTitle) {
        await refreshChapterSheet(chapterSheetTitle.titleId);
      }
      setFeedback({
        summary: '章节封面已更新',
        details: [],
        tone: 'normal'
      });
    } catch (error) {
      setFeedback({
        summary: error instanceof Error ? error.message : '更新章节封面失败',
        details: [],
        tone: 'warning'
      });
    } finally {
      setPendingChapterCoverId(null);
    }
  };

  const confirmRemoveChapter = async () => {
    if (!removingChapter) {
      return;
    }

    const target = removingChapter;
    setRemovingChapter(null);
    await libraryService.removeBook(target.bookId);
    await refreshChapterSheet(target.titleId);
  };

  const titleEntries = overview?.titleEntries ?? [];
  const displayedTitles = sortTitles(filterTitles(titleEntries, searchQuery), sortOrder);

  return (
    <main className="app-shell home-shell library-shell">
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
        ref={titleCoverInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        onChange={(event) => {
          void handleTitleCoverPick(event.target.files);
          event.currentTarget.value = '';
        }}
      />
      <input
        ref={chapterCoverInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        onChange={(event) => {
          void handleChapterCoverPick(event.target.files);
          event.currentTarget.value = '';
        }}
      />

      <section className="library-header">
        <div>
          <p className="eyebrow">© 2026 小宝专用. All rights reserved.</p>
          <h1>条漫阅读器</h1>
          <p className="hero-copy">专门用于小黄漫的长漫，竖向阅读</p>
        </div>

        <div className="library-tools">
          <label className="search-field search-field--wide">
            <span className="visually-hidden">搜索作品</span>
            <input
              value={searchQuery}
              placeholder="搜索作品名或章节名"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          <button className="icon-button" onClick={() => setSortSheetOpen(true)}>
            排序
          </button>
        </div>
      </section>

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

      <section className="content-block home-library-block">
        <div className="section-heading">
          <h2>书库</h2>
          <span>{displayedTitles.length} 个作品</span>
        </div>

        {titleEntries.length === 0 ? (
          <article className="empty-panel home-library-empty">
            <h3>还没有任何作品</h3>
            <p>先添加作品或章节。</p>
          </article>
        ) : displayedTitles.length === 0 ? (
          <article className="empty-panel home-library-empty">
            <h3>没有匹配的作品</h3>
            <p>换一个搜索关键词，或者点底部按钮继续添加内容。</p>
          </article>
        ) : (
          <div className="title-list">
            {displayedTitles.map((title) => (
              <TitleCard
                key={title.titleId}
                title={title}
                isRelinking={relinkLoadingBookId === getTitleLeadChapter(title)?.bookId}
                onOpen={handleTitleAction}
                onOpenMenu={setTitleMenu}
              />
            ))}
          </div>
        )}
        <button
          className="floating-add-button floating-add-button--library action-button action-button--primary"
          onClick={() => navigate('/add')}
        >
          添加作品 / 章节
        </button>
      </section>

      {sortSheetOpen ? (
        <HomeSheet title="排序方式" onClose={() => setSortSheetOpen(false)}>
          <div className="stack-actions">
            {[
              ['lastOpened', '最近阅读'],
              ['updated', '最近更新'],
              ['imported', '最近导入'],
              ['title', '作品名']
            ].map(([value, label]) => (
              <button
                key={value}
                className={`sheet-action ${sortOrder === value ? 'is-selected' : ''}`}
                onClick={() => {
                  setSortOrder(value as SortOrder);
                  setSortSheetOpen(false);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </HomeSheet>
      ) : null}

      {titleMenu ? (
        <HomeSheet title={titleMenu.displayTitle} subtitle={`${titleMenu.chapterCount} 章`} onClose={() => setTitleMenu(null)}>
          <div className="stack-actions">
            <button className="sheet-action" onClick={() => void openChapterSheet(titleMenu)}>
              查看章节列表
            </button>
            <button
              className="sheet-action"
              onClick={() => {
                setEditingTitle(titleMenu);
                setTitleDraft(titleMenu.displayTitle);
                setTitleMenu(null);
              }}
            >
              修改作品名
            </button>
            <button
              className="sheet-action"
              onClick={() => {
                setPendingTitleCoverId(titleMenu.titleId);
                titleCoverInputRef.current?.click();
                setTitleMenu(null);
              }}
            >
              修改作品封面
            </button>
            <button
              className="sheet-action is-danger"
              onClick={() => {
                void libraryService.removeTitle(titleMenu.titleId);
                setTitleMenu(null);
              }}
            >
              从书库移除
            </button>
          </div>
        </HomeSheet>
      ) : null}

      {chapterSheetTitle ? (
        <HomeSheet
          title={chapterSheetTitle.displayTitle}
          subtitle="章节列表"
          variant="half-wide"
          onClose={() => {
            setChapterSheetTitle(null);
            setChapterEntries([]);
          }}
        >
          <div className="chapter-list">
            {chapterEntries.map((chapter) => (
              <article key={chapter.bookId} className="chapter-row">
                <div className="chapter-row__cover">
                  <CoverImage bookId={chapter.bookId} title={chapter.displayTitle} coverRef={chapter.coverRef} />
                </div>
                <div className="chapter-row__meta">
                  <strong>{chapter.displayTitle}</strong>
                  <p className="muted-text">
                    {chapter.progress ? formatProgressSummary(chapter.progress) : '未开始'} ·{' '}
                    {chapter.availabilityStatus === 'available' ? '可打开' : chapter.availabilityReason ?? '不可用'}
                  </p>
                </div>
                <div className="chapter-row__text-actions">
                  <button className="text-action-button" onClick={() => void handleBookAction(chapter)}>
                    {chapter.availabilityStatus === 'available' ? '打开' : '修复'}
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
            ))}
          </div>
        </HomeSheet>
      ) : null}

      {editingTitle ? (
        <HomeSheet title="修改作品名" onClose={() => setEditingTitle(null)}>
          <label className="field">
            <span>作品名</span>
            <input value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} />
          </label>
          <div className="button-row">
            <button
              className="action-button action-button--primary"
              onClick={() => {
                void libraryService.renameTitle(editingTitle.titleId, titleDraft).then(() => {
                  setEditingTitle(null);
                });
              }}
            >
              保存
            </button>
          </div>
        </HomeSheet>
      ) : null}

      {editingChapter ? (
        <HomeSheet title="修改章节名" onClose={() => setEditingChapter(null)}>
          <label className="field">
            <span>章节名</span>
            <input value={chapterDraft} onChange={(event) => setChapterDraft(event.target.value)} />
          </label>
          <div className="button-row">
            <button
              className="action-button action-button--primary"
              onClick={() => {
                void libraryService.renameBook(editingChapter.bookId, chapterDraft).then(async () => {
                  if (chapterSheetTitle) {
                    await refreshChapterSheet(chapterSheetTitle.titleId);
                  }
                  setEditingChapter(null);
                });
              }}
            >
              保存
            </button>
          </div>
        </HomeSheet>
      ) : null}

      {removingChapter ? (
        <HomeSheet title="移除章节" onClose={() => setRemovingChapter(null)}>
          <p className="muted-text">确认移除章节「{removingChapter.displayTitle}」吗？此操作不可撤销。</p>
          <div className="button-row">
            <button className="action-button" onClick={() => setRemovingChapter(null)}>
              取消
            </button>
            <button className="action-button action-button--primary" onClick={() => void confirmRemoveChapter()}>
              确认移除
            </button>
          </div>
        </HomeSheet>
      ) : null}
    </main>
  );
}
