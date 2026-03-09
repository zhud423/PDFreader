const libraryEventTarget = new EventTarget();
const LIBRARY_CHANGED = 'library-changed';

export function emitLibraryChanged(): void {
  libraryEventTarget.dispatchEvent(new Event(LIBRARY_CHANGED));
}

export function subscribeLibraryChanged(listener: () => void): () => void {
  const wrapped = () => listener();
  libraryEventTarget.addEventListener(LIBRARY_CHANGED, wrapped);
  return () => {
    libraryEventTarget.removeEventListener(LIBRARY_CHANGED, wrapped);
  };
}

