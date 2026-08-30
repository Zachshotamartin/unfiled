import { rewriteNativeIntent } from "../features/capture/nativeIntent";

interface NativeIntentOptions {
  initial: boolean;
  path: string;
}

export function redirectSystemPath({ path }: NativeIntentOptions): string {
  return rewriteNativeIntent(path);
}
