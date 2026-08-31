const KEY_BYTES = 32;
const KEY_PATTERN = /^[0-9a-f]{64}$/u;

export interface CaptureKeyStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

export interface CaptureDatabaseKeyDependencies {
  randomBytes: () => Promise<Uint8Array>;
  storage: CaptureKeyStorage;
  storageKey: string;
}

function hexadecimal(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createCaptureDatabaseKeyLoader({
  randomBytes,
  storage,
  storageKey
}: CaptureDatabaseKeyDependencies): () => Promise<string> {
  let keyPromise: Promise<string> | undefined;
  return (): Promise<string> => {
    keyPromise ??= (async (): Promise<string> => {
      const stored = await storage.getItemAsync(storageKey);
      if (stored !== null) {
        if (!KEY_PATTERN.test(stored)) {
          throw new Error("The protected capture database key is invalid");
        }
        return stored;
      }

      const bytes = await randomBytes();
      if (bytes.byteLength !== KEY_BYTES) {
        throw new Error("Secure random key generation returned an invalid length");
      }
      const generated = hexadecimal(bytes);
      await storage.setItemAsync(storageKey, generated);
      const verified = await storage.getItemAsync(storageKey);
      if (verified !== generated) {
        throw new Error("The protected capture database key could not be verified");
      }
      return generated;
    })();
    return keyPromise;
  };
}
