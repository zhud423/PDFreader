import { watch, type FSWatcher } from 'node:fs';

export class WatchCoordinator {
  private watchers: FSWatcher[] = [];
  private rescanTimer: NodeJS.Timeout | null = null;
  private readonly onChange: () => Promise<void>;

  constructor(onChange: () => Promise<void>) {
    this.onChange = onChange;
  }

  async refresh(paths: string[], enabled: boolean): Promise<void> {
    this.dispose();

    if (!enabled || paths.length === 0) {
      return;
    }

    for (const folderPath of paths) {
      try {
        const watcher = watch(
          folderPath,
          {
            recursive: true
          },
          () => {
            this.schedule();
          }
        );
        this.watchers.push(watcher);
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        console.warn(`[PDFreader Helper] 跳过无效监听目录: ${folderPath} (${message})`);
      }
    }
  }

  dispose(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }

    for (const watcher of this.watchers) {
      watcher.close();
    }

    this.watchers = [];
  }

  private schedule(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
    }

    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      void this.onChange();
    }, 900);
  }
}
