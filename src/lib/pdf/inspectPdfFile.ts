import { getDocument } from './pdf';
import { sha256Hex } from '../../shared/utils/hash';

export interface PdfInspection {
  title: string;
  canonicalKey: string;
  pageCount: number;
  firstPageWidth: number;
  firstPageHeight: number;
  coverBlob: Blob;
  coverWidth: number;
  coverHeight: number;
  fileSize: number;
  fileName: string;
  mimeType: string;
}

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

export async function inspectPdfFile(file: File): Promise<PdfInspection> {
  if (!isPdfFile(file)) {
    throw new Error(`${file.name} 不是 PDF 文件。`);
  }

  const bytes = await file.arrayBuffer();
  const task = getDocument({ data: bytes });
  const pdf = await task.promise;

  try {
    const [firstPage, metadata] = await Promise.all([
      pdf.getPage(1),
      pdf.getMetadata().catch(() => null)
    ]);
    const baseViewport = firstPage.getViewport({ scale: 1 });
    const fileStem = file.name.replace(/\.pdf$/i, '');
    const documentInfo =
      metadata && typeof metadata.info === 'object' && metadata.info !== null
        ? (metadata.info as { Title?: unknown })
        : {};
    const rawTitle =
      typeof documentInfo.Title === 'string' && documentInfo.Title.trim()
        ? documentInfo.Title.trim()
        : fileStem;
    const canonicalSeed = [
      file.name.trim().toLowerCase(),
      file.size,
      pdf.numPages,
      Math.round(baseViewport.width),
      Math.round(baseViewport.height)
    ].join(':');
    const canonicalKey = await sha256Hex(canonicalSeed);
    const coverWidth = 320;
    const coverScale = coverWidth / baseViewport.width;
    const coverViewport = firstPage.getViewport({ scale: coverScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(coverViewport.width));
    canvas.height = Math.max(1, Math.round(coverViewport.height));

    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('无法创建封面渲染上下文。');
    }

    await firstPage.render({ canvasContext: context, viewport: coverViewport }).promise;

    const coverBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (!value) {
          reject(new Error('封面生成失败。'));
          return;
        }

        resolve(value);
      }, 'image/jpeg', 0.78);
    });

    return {
      title: rawTitle,
      canonicalKey,
      pageCount: pdf.numPages,
      firstPageWidth: Math.round(baseViewport.width),
      firstPageHeight: Math.round(baseViewport.height),
      coverBlob,
      coverWidth: canvas.width,
      coverHeight: canvas.height,
      fileSize: file.size,
      fileName: file.name,
      mimeType: file.type || 'application/pdf'
    };
  } finally {
    await pdf.destroy();
  }
}
