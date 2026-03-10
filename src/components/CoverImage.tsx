import { useEffect, useState } from 'react';
import { subscribeLibraryChanged } from '../services/libraryEvents';
import { libraryService } from '../services/libraryService';

interface CoverImageProps {
  bookId: string;
  title: string;
  coverRef?: string | null;
}

function isRemoteCover(coverRef?: string | null): coverRef is string {
  return typeof coverRef === 'string' && /^https?:\/\//.test(coverRef);
}

export function CoverImage({ bookId, title, coverRef }: CoverImageProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    return subscribeLibraryChanged(() => {
      setRefreshTick((value) => value + 1);
    });
  }, []);

  useEffect(() => {
    if (isRemoteCover(coverRef)) {
      setUrl(coverRef);
      return;
    }

    setUrl(null);
    let isMounted = true;
    let objectUrl: string | null = null;

    void libraryService.getCoverBlob(bookId).then((blob) => {
      if (!isMounted || !blob) {
        return;
      }

      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });

    return () => {
      isMounted = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [bookId, coverRef, refreshTick]);

  if (!url) {
    return (
      <div className="cover-image cover-image--fallback" aria-hidden="true">
        <span>{title.slice(0, 1) || 'P'}</span>
      </div>
    );
  }

  return <img className="cover-image" src={url} alt={`${title} 封面`} loading="lazy" />;
}
