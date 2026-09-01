import { KeyManagementErrorCode, keyManagementFailure } from "./types.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const PATTERN = /^[A-Za-z0-9_-]+$/u;

export function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const block = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += ALPHABET.charAt((block >>> 18) & 63);
    encoded += ALPHABET.charAt((block >>> 12) & 63);
    if (second !== undefined) encoded += ALPHABET.charAt((block >>> 6) & 63);
    if (third !== undefined) encoded += ALPHABET.charAt(block & 63);
  }
  return encoded;
}

export function decodeBase64Url(
  value: string,
  minimumBytes: number,
  maximumBytes: number
): Uint8Array {
  if (
    value.length === 0 ||
    value.length > Math.ceil((maximumBytes * 4) / 3) ||
    !PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Encoded key material is invalid");
  }

  const outputLength = Math.floor((value.length * 6) / 8);
  if (outputLength < minimumBytes || outputLength > maximumBytes) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Encoded key material is invalid");
  }
  const output = new Uint8Array(outputLength);
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;
  for (const character of value) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) {
      keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Encoded key material is invalid");
    }
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex] = (accumulator >>> bits) & 0xff;
      outputIndex += 1;
    }
  }
  if (outputIndex !== output.length || encodeBase64Url(output) !== value) {
    output.fill(0);
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Encoded key material is invalid");
  }
  return output;
}
