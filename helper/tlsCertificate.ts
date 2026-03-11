import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';

export interface HelperTlsArtifacts {
  keyPath: string;
  certPath: string;
  caCertPath: string;
  caCerPath: string;
  tlsDir: string;
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} 执行失败。`));
    });
  });
}

function sanitizeDnsName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9.-]/g, '').replace(/^\.+|\.+$/g, '');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildServerConfig(hostnames: string[], lanIps: string[]): string {
  const dnsNames = Array.from(new Set(['localhost', ...hostnames.map(sanitizeDnsName).filter(Boolean)]));
  const ipNames = Array.from(new Set(['127.0.0.1', ...lanIps]));

  const altNameLines: string[] = [];
  dnsNames.forEach((name, index) => {
    altNameLines.push(`DNS.${index + 1} = ${name}`);
  });
  ipNames.forEach((value, index) => {
    altNameLines.push(`IP.${index + 1} = ${value}`);
  });

  return `[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = PDFreader Helper

[v3_req]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
${altNameLines.join('\n')}
`;
}

function buildCaConfig(): string {
  return `[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_ca
prompt = no

[req_distinguished_name]
CN = PDFreader Helper Local CA

[v3_ca]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical,CA:true
keyUsage = critical,keyCertSign,cRLSign
`;
}

function buildHostnames(): string[] {
  const rawHost = os.hostname().trim();
  if (!rawHost) {
    return [];
  }

  if (rawHost.includes('.')) {
    const plain = rawHost.split('.')[0];
    return plain ? [rawHost, plain] : [rawHost];
  }

  return [rawHost, `${rawHost}.local`];
}

async function ensureCaCertificate(tlsDir: string): Promise<{ caCertPath: string; caKeyPath: string }> {
  const caCertPath = path.join(tlsDir, 'helper-ca.pem');
  const caKeyPath = path.join(tlsDir, 'helper-ca.key');
  const caConfigPath = path.join(tlsDir, 'helper-ca.cnf');
  const caCertExists = await fileExists(caCertPath);
  const caKeyExists = await fileExists(caKeyPath);
  if (caCertExists && caKeyExists) {
    return { caCertPath, caKeyPath };
  }

  await writeFile(caConfigPath, buildCaConfig(), 'utf8');

  await runCommand('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '3650',
    '-nodes',
    '-keyout',
    caKeyPath,
    '-out',
    caCertPath,
    '-config',
    caConfigPath
  ]).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`生成本地 CA 失败：${message}`);
  });

  return { caCertPath, caKeyPath };
}

async function ensureCaDerCertificate(caCertPath: string, tlsDir: string): Promise<string> {
  const caCerPath = path.join(tlsDir, 'helper-ca.cer');
  const derExists = await fileExists(caCerPath);
  if (derExists) {
    return caCerPath;
  }

  await runCommand('openssl', ['x509', '-in', caCertPath, '-outform', 'der', '-out', caCerPath]).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`导出 DER 证书失败：${message}`);
  });

  return caCerPath;
}

async function issueServerCertificate(params: {
  tlsDir: string;
  caCertPath: string;
  caKeyPath: string;
  hostnames: string[];
  lanIps: string[];
}): Promise<{ keyPath: string; certPath: string }> {
  const keyPath = path.join(params.tlsDir, 'helper-server.key');
  const certPath = path.join(params.tlsDir, 'helper-server.pem');
  const csrPath = path.join(params.tlsDir, 'helper-server.csr');
  const extPath = path.join(params.tlsDir, 'helper-server.cnf');
  const serialPath = path.join(params.tlsDir, 'helper-ca.srl');

  await writeFile(extPath, buildServerConfig(params.hostnames, params.lanIps), 'utf8');
  await rm(keyPath, { force: true }).catch(() => undefined);
  await rm(certPath, { force: true }).catch(() => undefined);

  await runCommand('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    csrPath,
    '-config',
    extPath
  ]).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`生成服务器 CSR 失败：${message}`);
  });

  await runCommand('openssl', [
    'x509',
    '-req',
    '-in',
    csrPath,
    '-CA',
    params.caCertPath,
    '-CAkey',
    params.caKeyPath,
    '-CAcreateserial',
    '-CAserial',
    serialPath,
    '-out',
    certPath,
    '-days',
    '825',
    '-sha256',
    '-extensions',
    'v3_req',
    '-extfile',
    extPath
  ]).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`签发服务器证书失败：${message}`);
  });

  await rm(csrPath, { force: true }).catch(() => undefined);
  await rm(serialPath, { force: true }).catch(() => undefined);
  return { keyPath, certPath };
}

export async function ensureHelperTlsArtifacts(dataDir: string, lanIps: string[]): Promise<HelperTlsArtifacts> {
  const tlsDir = path.join(dataDir, 'tls');
  await mkdir(tlsDir, { recursive: true });

  const hostnames = buildHostnames();
  const { caCertPath, caKeyPath } = await ensureCaCertificate(tlsDir);
  const caCerPath = await ensureCaDerCertificate(caCertPath, tlsDir);
  const { keyPath, certPath } = await issueServerCertificate({
    tlsDir,
    caCertPath,
    caKeyPath,
    hostnames,
    lanIps
  });

  return {
    keyPath,
    certPath,
    caCertPath,
    caCerPath,
    tlsDir
  };
}
