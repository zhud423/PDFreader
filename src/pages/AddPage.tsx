import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { subscribeLibraryChanged } from '../services/libraryEvents';
import {
  type ImportOptions,
  libraryService,
  type HomeOverview,
  type ImportResult,
  type RemoteSourceSyncResult,
  type SourceSummary
} from '../services/libraryService';
import { formatRelativeTime, formatSourceStatusLabel } from '../shared/utils/format';

interface AddPageFeedback {
  summary: string;
  details: string[];
  tone: 'normal' | 'warning';
}

interface SourceDraft {
  name: string;
  baseUrl: string;
}

type ImportFlowMode = 'new' | 'existing';

function buildImportFeedback(result: ImportResult): AddPageFeedback {
  const addedCount = result.imported.length;
  const parts: string[] = [];
  const details: string[] = [];

  if (addedCount > 0) {
    parts.push(`新增 ${addedCount} 章`);
  }

  if (result.duplicateContentCount > 0) {
    parts.push(`重复内容 ${result.duplicateContentCount} 章（已按新章节导入）`);
    details.push(
      ...result.duplicateContentFiles.map(
        (item) => `${item.fileName}：与《${item.matchedTitleName}》-《${item.matchedChapterName}》内容重复，已继续新建章节。`
      )
    );
  }

  if (result.failed.length > 0) {
    parts.push(`失败 ${result.failed.length} 个文件`);
    details.push(...result.failed.map((item) => `${item.fileName}: ${item.reason}`));
  }

  return {
    summary: parts.join('，') || '没有可导入的 PDF',
    details,
    tone: result.failed.length > 0 || result.duplicateContentCount > 0 ? 'warning' : 'normal'
  };
}

function buildRemoteSourceFeedback(result: RemoteSourceSyncResult): AddPageFeedback {
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
        <span>{source.totalBooks} 章</span>
        <span>{source.availableBooks} 章可读</span>
        <span>{source.unavailableBooks} 章不可用</span>
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

export function AddPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const existingInputRef = useRef<HTMLInputElement | null>(null);
  const newTitleInputRef = useRef<HTMLInputElement | null>(null);
  const titleCoverInputRef = useRef<HTMLInputElement | null>(null);
  const pendingImportOptionsRef = useRef<ImportOptions | undefined>(undefined);
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [feedback, setFeedback] = useState<AddPageFeedback | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [syncingSourceId, setSyncingSourceId] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>({ name: '', baseUrl: '' });
  const [lastImportedBookId, setLastImportedBookId] = useState<string | null>(null);
  const [existingTitleId, setExistingTitleId] = useState('');
  const [newTitleName, setNewTitleName] = useState('');
  const [newTitleCoverName, setNewTitleCoverName] = useState('');
  const [newTitleCoverFile, setNewTitleCoverFile] = useState<File | null>(null);
  const [importFlowMode, setImportFlowMode] = useState<ImportFlowMode>('new');
  const canImportAsNewTitle = Boolean(newTitleName.trim() && newTitleCoverFile) && !isImporting;

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

    void guardedLoad();
    const unsubscribe = subscribeLibraryChanged(() => {
      void guardedLoad();
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
    setFeedback({
      summary: '正在导入章节',
      details: ['正在解析 PDF、生成封面并写入书库，请稍候...'],
      tone: 'normal'
    });
    setLastImportedBookId(null);

    try {
      const importOptions = pendingImportOptionsRef.current;
      const isNewTitleImport = Boolean(importOptions?.newTitleName);
      const result = await libraryService.importLocalFiles(pickedFiles, importOptions);
      if (newTitleCoverFile && result.imported[0] && isNewTitleImport) {
        await libraryService.setTitleCoverFile(result.imported[0].titleId, newTitleCoverFile);
      }
      setFeedback(buildImportFeedback(result));
      setLastImportedBookId(result.imported.at(0)?.bookId ?? null);
      if (isNewTitleImport) {
        setNewTitleName('');
        setNewTitleCoverName('');
        setNewTitleCoverFile(null);
      }
      await loadOverview();
    } finally {
      pendingImportOptionsRef.current = undefined;
      setIsImporting(false);
    }
  };

  const openImportPicker = (target: 'existing' | 'new') => {
    if (target === 'existing') {
      pendingImportOptionsRef.current = existingTitleId ? { targetTitleId: existingTitleId } : undefined;
      existingInputRef.current?.click();
      return;
    }

    if (!newTitleName.trim() || !newTitleCoverFile) {
      setFeedback({
        summary: '请先填写作品名并选择作品封面',
        details: ['再选择多个 PDF 创建新作品。'],
        tone: 'warning'
      });
      return;
    }

    pendingImportOptionsRef.current = newTitleName.trim() ? { newTitleName } : undefined;
    newTitleInputRef.current?.click();
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
      await loadOverview();
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

  const remoteSources = (overview?.sourceSummaries ?? []).filter((source) => source.sourceType === 'remote_url');
  const titleEntries = overview?.titleEntries ?? [];
  const focusRemote = searchParams.get('focus') === 'remote';
  const operationLoadingText = isImporting
    ? '正在加载图书并导入章节（解析 PDF、生成封面、写入书库）...'
    : syncingSourceId
      ? '正在连接并同步局域网书源，请稍候...'
      : null;

  return (
    <main className="app-shell add-shell">
      <input
        ref={existingInputRef}
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
        ref={newTitleInputRef}
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
        ref={titleCoverInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          setNewTitleCoverFile(file);
          setNewTitleCoverName(file?.name ?? '');
          event.currentTarget.value = '';
        }}
      />

      <section className="page-bar">
        <Link className="icon-button" to="/">
          返回
        </Link>
        <div className="page-bar__title">
          <h1>添加内容</h1>
          <p className="muted-text">本地书源和局域网书源统一从这里进入。</p>
        </div>
      </section>

      <section className="content-block add-section">
        <div className="section-heading">
          <h2>本地书源导入</h2>
        </div>
        <div className="add-flow-selector">
          <p className="muted-text">选择导入路经</p>
          <div className="add-flow-radio-group" role="radiogroup" aria-label="导入路径">
            <label className={`add-flow-radio ${importFlowMode === 'new' ? 'is-active' : ''}`}>
              <input
                type="radio"
                name="import-flow-mode"
                value="new"
                checked={importFlowMode === 'new'}
                onChange={() => setImportFlowMode('new')}
              />
              <span>添加作品并导入章节</span>
            </label>
            <label className={`add-flow-radio ${importFlowMode === 'existing' ? 'is-active' : ''}`}>
              <input
                type="radio"
                name="import-flow-mode"
                value="existing"
                checked={importFlowMode === 'existing'}
                onChange={() => setImportFlowMode('existing')}
              />
              <span>添加章节到已有作品</span>
            </label>
          </div>
        </div>

        {importFlowMode === 'new' ? (
          <article className="local-import-route">
            <div className="section-heading">
              <h3>添加新作品</h3>
              <span>填写作品信息后批量导入章节</span>
            </div>

            <div className="local-import-create">
              <label className="field">
                <span>作品名</span>
                <input
                  value={newTitleName}
                  placeholder="例如：危险遭遇"
                  onChange={(event) => setNewTitleName(event.target.value)}
                />
              </label>
              <div className="local-import-action-row">
                <span>作品封面</span>
                <button
                  className="action-button local-action-button"
                  onClick={() => titleCoverInputRef.current?.click()}
                  disabled={isImporting}
                >
                  {newTitleCoverName || '选择图片'}
                </button>
              </div>
              <div className="local-import-action-row">
                <span>章节 PDF</span>
                <button
                  className="action-button action-button--primary local-action-button"
                  onClick={() => openImportPicker('new')}
                  disabled={!canImportAsNewTitle}
                >
                  {isImporting ? '正在导入...' : '选择多个 PDF 并创建作品'}
                </button>
              </div>
            </div>
          </article>
        ) : (
          <article className="local-import-route">
            <div className="section-heading">
              <h3>添加新章节</h3>
              <span>支持批量选择多个 PDF</span>
            </div>

            {titleEntries.length > 0 ? (
              <>
                <label className="field">
                  <span>目标作品</span>
                  <select value={existingTitleId} onChange={(event) => setExistingTitleId(event.target.value)}>
                    <option value="">请选择一个作品</option>
                    {titleEntries.map((entry) => (
                      <option key={entry.titleId} value={entry.titleId}>
                        {entry.displayTitle} · {entry.chapterCount} 章
                      </option>
                    ))}
                  </select>
                </label>
                <div className="button-row">
                  <button
                    className="action-button action-button--primary"
                    onClick={() => openImportPicker('existing')}
                    disabled={!existingTitleId || isImporting}
                  >
                    {isImporting ? '正在导入...' : '选择多个 PDF'}
                  </button>
                </div>
              </>
            ) : (
              <article className="empty-panel">
                <h3>还没有可归属的作品</h3>
                <p>请先用路径一新建一个作品，然后再通过路径二追加章节。</p>
              </article>
            )}
          </article>
        )}

        <div className="operation-feedback-block">
          {operationLoadingText ? (
            <p className="inline-message operation-loading-message">{operationLoadingText}</p>
          ) : null}

          {feedback ? (
            <div className={`feedback-panel ${feedback.tone === 'warning' ? 'is-warning' : ''}`}>
              <p>{feedback.summary}</p>
              {feedback.details.length > 0 ? (
                <ul className="feedback-panel__list">
                  {feedback.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
              {lastImportedBookId && !operationLoadingText ? (
                <div className="button-row">
                  <button
                    className="action-button action-button--primary"
                    onClick={() => navigate(`/reader/${lastImportedBookId}`)}
                  >
                    打开刚导入的章节
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="muted-text">这里会显示导入和同步结果，成功后可直接打开阅读。</p>
          )}
        </div>
      </section>

      <section className={`content-block add-section ${focusRemote ? 'is-highlighted' : ''}`}>
        <div className="section-heading">
          <h2>局域网书源</h2>
          <span>静态 library.json 协议</span>
        </div>

        <div className="source-form">
          <label className="field">
            <span>名称</span>
            <input
              value={sourceDraft.name}
              placeholder="例如：家里 NAS"
              onChange={(event) => setSourceDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="field field--wide">
            <span>地址</span>
            <input
              value={sourceDraft.baseUrl}
              placeholder="https://nas-home.example.com/comics"
              onChange={(event) => setSourceDraft((current) => ({ ...current, baseUrl: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>导入策略</span>
            <select value="auto_remote" disabled>
              <option value="auto_remote">自动按远程结构建作品</option>
            </select>
          </label>
          <button
            className="action-button action-button--primary"
            onClick={() => void handleRemoteSourceSubmit()}
            disabled={syncingSourceId === 'new' || isImporting}
          >
            {syncingSourceId === 'new' ? '正在连接...' : '保存并同步'}
          </button>
        </div>

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
            <p>先添加一个可访问的 HTTPS 目录，后续这里会继续承接来源管理与同步。</p>
          </article>
        )}
      </section>
    </main>
  );
}
