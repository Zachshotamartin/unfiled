"use client";

import { createCaptureLocalStore } from "./capture-store";
import { createIndexedDbCapturePersistence } from "./indexeddb-persistence";

export const browserCaptureStore = createCaptureLocalStore(createIndexedDbCapturePersistence());
