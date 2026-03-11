import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import crypto from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfInspectionResult {
  title: string;
  contentHash: string;
  fileSize: number;
  mimeType: string;
  pageCount: number;
  firstPageWidth: number;
  firstPageHeight: number;
  modifiedAt: string;
}

export async function inspectPdfPath(filePath: string): Promise<PdfInspectionResult> {
  const [fileStats, fileBuffer] = await Promise.all([stat(filePath), readFile(filePath)]);
  const bytes = new Uint8Array(fileBuffer);
  const contentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const task = getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false
  });
  const pdf = await task.promise;

  try {
    const [firstPage, metadata] = await Promise.all([
      pdf.getPage(1),
      pdf.getMetadata().catch(() => null)
    ]);
    const viewport = firstPage.getViewport({ scale: 1 });
    const info =
      metadata && typeof metadata.info === 'object' && metadata.info !== null
        ? (metadata.info as { Title?: unknown })
        : {};
    const title =
      typeof info.Title === 'string' && info.Title.trim()
        ? info.Title.trim()
        : path.basename(filePath, path.extname(filePath));

    return {
      title,
      contentHash,
      fileSize: fileStats.size,
      mimeType: 'application/pdf',
      pageCount: pdf.numPages,
      firstPageWidth: Math.max(1, Math.round(viewport.width)),
      firstPageHeight: Math.max(1, Math.round(viewport.height)),
      modifiedAt: new Date(fileStats.mtimeMs).toISOString()
    };
  } finally {
    await pdf.destroy();
  }
}
