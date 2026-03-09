import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

const HomePage = lazy(async () => {
  const module = await import('../pages/HomePage');
  return { default: module.HomePage };
});

const ReaderPage = lazy(async () => {
  const module = await import('../pages/ReaderPage');
  return { default: module.ReaderPage };
});

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<main className="reader-state-block"><h1>正在加载应用...</h1></main>}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/reader/:bookId" element={<ReaderPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
