import QRCode from 'qrcode';

const svgCache = new Map<string, string>();

export async function renderQrSvg(value: string): Promise<string> {
  const cached = svgCache.get(value);
  if (cached) {
    return cached;
  }

  const svg = await QRCode.toString(value, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
    color: {
      dark: '#1f1b16',
      light: '#fffdf9'
    }
  });
  svgCache.set(value, svg);
  return svg;
}
