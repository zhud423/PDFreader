import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { HelperService } from './helperService.ts';
import { listLanIpv4Addresses } from './network.ts';
import { ensureHelperTlsArtifacts } from './tlsCertificate.ts';
import { WatchCoordinator } from './watchCoordinator.ts';
import { openUrlInBrowser } from './openBrowser.ts';

function getPort(): number {
  const input = Number(process.env.PDFREADER_HELPER_PORT ?? 48321);
  return Number.isInteger(input) && input > 0 ? input : 48321;
}

function getTlsPort(httpPort: number): number {
  const fallback = httpPort + 1;
  const input = Number(process.env.PDFREADER_HELPER_TLS_PORT ?? fallback);
  return Number.isInteger(input) && input > 0 ? input : fallback;
}

function shouldEnableTls(): boolean {
  return process.env.PDFREADER_HELPER_ENABLE_TLS !== '0';
}

const helperRoot = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.join(helperRoot, 'static');
const port = getPort();
const tlsPort = getTlsPort(port);
const service = new HelperService({
  port,
  tlsPort
});
const watchCoordinator = new WatchCoordinator(async () => {
  await service.rescan();
});

const contentTypes = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.pdf', 'application/pdf']
]);

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function sendSvg(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function serveStatic(response: ServerResponse, filePath: string): Promise<void> {
  const extension = path.extname(filePath).toLowerCase();
  const type = contentTypes.get(extension) ?? 'application/octet-stream';
  const info = await stat(filePath);

  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(info.size)
  });

  createReadStream(filePath).pipe(response);
}

function withCors(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, POST, DELETE');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Cache-Control', 'no-store');
}

async function serveSource(requestPath: string, response: ServerResponse): Promise<void> {
  const state = await service.getState();
  withCors(response);

  if (!state.sharingEnabled) {
    sendJson(response, 503, {
      error: 'sharing_disabled',
      message: '当前未开启共享。'
    });
    return;
  }

  if (requestPath === '/source/library.json') {
    sendJson(response, 200, await service.getManifest());
    return;
  }

  const coverMatch = /^\/source\/covers\/([a-zA-Z0-9-]+\.png)$/.exec(requestPath);
  if (coverMatch) {
    await serveStatic(response, path.join(service.coverDir, coverMatch[1]));
    return;
  }

  const bookMatch = /^\/source\/books\/([a-zA-Z0-9-]+)\.pdf$/.exec(requestPath);
  if (bookMatch) {
    const entry = await service.getLibraryEntryById(bookMatch[1]);
    if (!entry) {
      sendJson(response, 404, { error: 'not_found', message: '找不到对应 PDF。' });
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': String((await stat(entry.filePath)).size)
    });
    createReadStream(entry.filePath).pipe(response);
    return;
  }

  sendJson(response, 404, { error: 'not_found', message: '来源资源不存在。' });
}

async function servePage(response: ServerResponse, fileName: string): Promise<void> {
  await serveStatic(response, path.join(staticRoot, fileName));
}

async function serveQr(pathname: string, response: ServerResponse): Promise<void> {
  const match = /^\/qr\/(primary|connect|source|add)\.svg$/.exec(pathname);
  if (!match) {
    sendText(response, 404, 'Not Found');
    return;
  }

  const svg = await service.getQrSvg(match[1] as 'primary' | 'connect' | 'source' | 'add');
  sendSvg(response, 200, svg);
}

async function serveCaCertificate(pathname: string, response: ServerResponse): Promise<void> {
  if (pathname !== '/certs/helper-ca.pem' && pathname !== '/certs/helper-ca.cer') {
    sendText(response, 404, 'Not Found');
    return;
  }

  const caCertPath = service.getTlsCaCertPath();
  if (!caCertPath) {
    sendJson(response, 503, {
      error: 'tls_not_ready',
      message: '当前 HTTPS 证书还未准备好。'
    });
    return;
  }

  const info = await stat(caCertPath);
  const fileName = pathname.endsWith('.cer') ? 'PDFreader-Helper-CA.cer' : 'PDFreader-Helper-CA.pem';
  response.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Content-Length': String(info.size),
    'Cache-Control': 'no-store'
  });
  createReadStream(caCertPath).pipe(response);
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<void> {
  withCors(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === 'GET' && pathname === '/api/state') {
    sendJson(response, 200, await service.getSnapshot());
    return;
  }

  if (request.method === 'GET' && pathname === '/api/consumer') {
    sendJson(response, 200, await service.getConsumerState());
    return;
  }

  if (request.method === 'POST' && pathname === '/api/source-name') {
    const body = await readJsonBody(request);
    const sourceName = typeof body.sourceName === 'string' ? body.sourceName : '';
    sendJson(response, 200, await service.updateSourceName(sourceName));
    return;
  }

  if (request.method === 'POST' && pathname === '/api/app-base-url') {
    const body = await readJsonBody(request);
    const appBaseUrl = typeof body.appBaseUrl === 'string' ? body.appBaseUrl : '';
    sendJson(response, 200, await service.updateAppBaseUrl(appBaseUrl));
    return;
  }

  if (request.method === 'POST' && pathname === '/api/folders/manual') {
    const body = await readJsonBody(request);
    const folderPath = typeof body.path === 'string' ? body.path : '';
    sendJson(response, 200, await service.addFolderPath(folderPath));
    return;
  }

  if (request.method === 'POST' && pathname === '/api/folders/choose') {
    const result = await service.chooseAndAddFolder();
    sendJson(response, 200, {
      folder: result,
      cancelled: result === null
    });
    return;
  }

  if (request.method === 'DELETE' && pathname.startsWith('/api/folders/')) {
    const folderId = pathname.slice('/api/folders/'.length);
    sendJson(response, 200, await service.removeFolder(folderId));
    return;
  }

  if (request.method === 'POST' && pathname === '/api/share/start') {
    sendJson(response, 200, await service.startSharing());
    return;
  }

  if (request.method === 'POST' && pathname === '/api/share/stop') {
    sendJson(response, 200, await service.stopSharing());
    return;
  }

  if (request.method === 'POST' && pathname === '/api/rescan') {
    sendJson(response, 200, await service.rescan());
    return;
  }

  sendJson(response, 404, { error: 'not_found', message: 'API 路径不存在。' });
}

async function start(): Promise<void> {
  await service.initialize();
  const refreshWatchers = async () => {
    const state = await service.getState();
    await watchCoordinator.refresh(
      state.folders.map((folder) => folder.path),
      state.sharingEnabled
    );
  };

  async function requestHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;

      if (pathname.startsWith('/api/')) {
        await handleApi(request, response, pathname);
        if (request.method !== 'GET') {
          await refreshWatchers();
        }
        return;
      }

      if (pathname === '/source/library.json' || pathname.startsWith('/source/books/') || pathname.startsWith('/source/covers/')) {
        await serveSource(pathname, response);
        return;
      }

      if (pathname === '/certs/helper-ca.pem' || pathname === '/certs/helper-ca.cer') {
        await serveCaCertificate(pathname, response);
        return;
      }

      if (pathname === '/connect' || pathname === '/') {
        await servePage(response, 'connect.html');
        return;
      }

      if (pathname === '/manage') {
        await servePage(response, 'manage.html');
        return;
      }

      if (pathname.startsWith('/qr/')) {
        await serveQr(pathname, response);
        return;
      }

      if (pathname === '/styles.css' || pathname === '/manage.js' || pathname === '/connect.js') {
        await serveStatic(response, path.join(staticRoot, pathname.slice(1)));
        return;
      }

      sendText(response, 404, 'Not Found');
    } catch (error) {
      const message = error instanceof Error ? error.message : '服务器内部错误';
      sendJson(response, 500, {
        error: 'internal_error',
        message
      });
    }
  }

  if (shouldEnableTls()) {
    try {
      if (tlsPort === port) {
        throw new Error('HTTPS 端口不能和 HTTP 端口相同。');
      }
      const artifacts = await ensureHelperTlsArtifacts(service.store.dataDir, listLanIpv4Addresses());
      service.setTlsStatus({
        enabled: true,
        port: tlsPort,
        caCertPath: artifacts.caCertPath
      });
      const secureServer = createHttpsServer(
        {
          key: await readFile(artifacts.keyPath),
          cert: await readFile(artifacts.certPath)
        },
        (request, response) => {
          void requestHandler(request, response);
        }
      );
      secureServer.on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        service.setTlsStatus({ enabled: false });
        console.warn(`[helper] HTTPS 服务异常，已回退为 HTTP 书源：${message}`);
      });
      secureServer.listen(tlsPort, '0.0.0.0');
    } catch (error) {
      service.setTlsStatus({
        enabled: false
      });
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[helper] HTTPS 启动失败，已回退为 HTTP 书源：${message}`);
    }
  } else {
    service.setTlsStatus({
      enabled: false
    });
  }

  await refreshWatchers();

  const server = createHttpServer((request, response) => {
    void requestHandler(request, response);
  });

  server.listen(port, '0.0.0.0', () => {
    // Keep the startup output short so users can copy the URLs quickly.
    console.log(service.getServerBanner());
    if (process.env.PDFREADER_HELPER_OPEN_BROWSER !== '0') {
      void openUrlInBrowser(`http://127.0.0.1:${port}/manage`).catch(() => undefined);
    }
  });
}

void start();
