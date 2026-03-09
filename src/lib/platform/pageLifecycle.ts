export interface PageLifecycleCallbacks {
  onHidden?: () => void;
  onVisible?: () => void;
  onPageHide?: () => void;
}

export function subscribePageLifecycle(callbacks: PageLifecycleCallbacks): () => void {
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      callbacks.onHidden?.();
      return;
    }

    callbacks.onVisible?.();
  };

  const handlePageHide = () => {
    callbacks.onPageHide?.();
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pagehide', handlePageHide);

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pagehide', handlePageHide);
  };
}

