const encoder = new TextEncoder();

type HashInput = string | ArrayBuffer | ArrayBufferView;

function normalizeHashInput(input: HashInput): BufferSource {
  if (typeof input === 'string') {
    return encoder.encode(input);
  }

  if (input instanceof ArrayBuffer) {
    return input;
  }

  const copy = new Uint8Array(input.byteLength);
  copy.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  return copy;
}

export async function sha256Hex(input: HashInput): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', normalizeHashInput(input));
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
