import { useEffect, useState } from 'react';
import { libraryService } from '../services/libraryService';

interface CoverImageProps {
  bookId: string;
  title: string;
}

export function CoverImage({ bookId, title }: CoverImageProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
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
  }, [bookId]);

  if (!url) {
    return (
      <div className="cover-image cover-image--fallback" aria-hidden="true">
        <span>{title.slice(0, 1) || 'P'}</span>
      </div>
    );
  }

  return <img className="cover-image" src={url} alt={`${title} 封面`} loading="lazy" />;
}

