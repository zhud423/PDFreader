import { useEffect, useRef, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISS_STORAGE_KEY = 'pdfreader.install-banner.dismissed-at';
const DISMISS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function getDismissedAt(): number {
  const raw = window.localStorage.getItem(DISMISS_STORAGE_KEY);
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function isStandaloneMode(): boolean {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia('(display-mode: standalone)').matches || navigatorWithStandalone.standalone === true
  );
}

function isIosSafari(): boolean {
  const userAgent = navigator.userAgent.toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(userAgent);
  const isSafari = /safari/.test(userAgent) && !/crios|fxios|edgios/.test(userAgent);
  return isIos && isSafari;
}

export interface InstallPromptState {
  mode: 'hidden' | 'browser' | 'ios';
  isStandalone: boolean;
  dismiss: () => void;
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unsupported'>;
}

export function useInstallPrompt(): InstallPromptState {
  const installEventRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [mode, setMode] = useState<'hidden' | 'browser' | 'ios'>('hidden');
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const standalone = isStandaloneMode();
    setIsStandalone(standalone);

    if (standalone) {
      setMode('hidden');
      return;
    }

    if (Date.now() - getDismissedAt() < DISMISS_WINDOW_MS) {
      setMode('hidden');
      return;
    }

    if (isIosSafari()) {
      setMode('ios');
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      installEventRef.current = event as BeforeInstallPromptEvent;
      setMode('browser');
    };

    const handleInstalled = () => {
      installEventRef.current = null;
      window.localStorage.removeItem(DISMISS_STORAGE_KEY);
      setIsStandalone(true);
      setMode('hidden');
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt as EventListener);
    window.addEventListener('appinstalled', handleInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt as EventListener);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
    setMode('hidden');
  };

  const promptInstall = async (): Promise<'accepted' | 'dismissed' | 'unsupported'> => {
    if (!installEventRef.current) {
      return 'unsupported';
    }

    await installEventRef.current.prompt();
    const choice = await installEventRef.current.userChoice;

    if (choice.outcome === 'accepted') {
      window.localStorage.removeItem(DISMISS_STORAGE_KEY);
      setMode('hidden');
      return 'accepted';
    }

    return 'dismissed';
  };

  return {
    mode,
    isStandalone,
    dismiss,
    promptInstall
  };
}

