import os from 'node:os';
import type { LanUrlRecord } from './types.ts';

function uniqueByAddress(records: LanUrlRecord[]): LanUrlRecord[] {
  const seen = new Set<string>();
  const unique: LanUrlRecord[] = [];

  for (const record of records) {
    if (seen.has(record.address)) {
      continue;
    }

    seen.add(record.address);
    unique.push(record);
  }

  return unique;
}

function isLanIpv4(address: string): boolean {
  return (
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
  );
}

export function listLanIpv4Addresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const [label, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isLanIpv4(entry.address)) {
        continue;
      }

      if (!label) {
        continue;
      }
      addresses.push(entry.address);
    }
  }

  return Array.from(new Set(addresses)).sort((left, right) => left.localeCompare(right));
}

export function listLanUrls(port: number, protocol: 'http' | 'https' = 'http'): LanUrlRecord[] {
  const interfaces = os.networkInterfaces();
  const urls: LanUrlRecord[] = [];

  for (const [label, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isLanIpv4(entry.address)) {
        continue;
      }

      urls.push({
        label,
        address: entry.address,
        protocol,
        sourceBaseUrl: `${protocol}://${entry.address}:${port}/source`,
        connectUrl: `${protocol}://${entry.address}:${port}/connect`
      });
    }
  }

  return uniqueByAddress(urls).sort((left, right) => left.address.localeCompare(right.address));
}
