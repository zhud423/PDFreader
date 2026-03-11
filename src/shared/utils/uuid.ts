function fillRandomBytes(target: Uint8Array): void {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(target);
    return;
  }

  for (let index = 0; index < target.length; index += 1) {
    target[index] = Math.floor(Math.random() * 256);
  }
}

export function createUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  fillRandomBytes(bytes);

  // RFC 4122 v4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const segments = [
    bytes.subarray(0, 4),
    bytes.subarray(4, 6),
    bytes.subarray(6, 8),
    bytes.subarray(8, 10),
    bytes.subarray(10, 16)
  ];

  return segments
    .map((segment) =>
      Array.from(segment)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
    )
    .join('-');
}
