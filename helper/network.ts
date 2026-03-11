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

export function listLanUrls(port: number): LanUrlRecord[] {
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
        sourceBaseUrl: `http://${entry.address}:${port}/source`,
        connectUrl: `http://${entry.address}:${port}/connect`
      });
    }
  }

  return uniqueByAddress(urls).sort((left, right) => left.address.localeCompare(right.address));
}
