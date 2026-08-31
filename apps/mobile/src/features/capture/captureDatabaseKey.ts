import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import { createCaptureDatabaseKeyLoader } from "./captureDatabaseKeyCore";

const CAPTURE_DATABASE_KEY = "unfiled.capture-database-key.v1";
const KEY_BYTES = 32;
const storageOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: CAPTURE_DATABASE_KEY,
  requireAuthentication: false
};

export const getCaptureDatabaseKey = createCaptureDatabaseKeyLoader({
  randomBytes: () => Crypto.getRandomBytesAsync(KEY_BYTES),
  storage: {
    getItemAsync: (key) => SecureStore.getItemAsync(key, storageOptions),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, storageOptions)
  },
  storageKey: CAPTURE_DATABASE_KEY
});
