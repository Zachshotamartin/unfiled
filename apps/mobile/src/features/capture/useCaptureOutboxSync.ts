import { createApiClient } from "@unfiled/api-client";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { useSession } from "../../auth/AuthProvider";
import { pendingCaptureCount, resumeCaptureOutboxAfterSignIn } from "./captureDraftRepository";
import { drainCaptureDeleteIntents } from "./captureActionCoordinator";
import { drainCaptureOutbox } from "./captureOutboxCoordinator";
import { subscribeToCaptureOutboxDrain } from "./captureOutboxSignals";
import { scheduleWidgetPendingCount } from "./lockScreenCapture";
import {
  sqliteCaptureDeleteIntentStore,
  sqliteCaptureOutboxStore
} from "./sqliteCaptureOutboxStore";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3000";
const RETRY_TICK_MS = 5_000;

export function useCaptureOutboxSync(): () => Promise<void> {
  const { getAccessToken, session } = useSession();
  const drainPromise = useRef<Promise<void> | null>(null);
  const profileId = session?.user.id ?? null;

  const drain = useCallback((): Promise<void> => {
    if (profileId === null) return Promise.resolve();
    if (drainPromise.current !== null) return drainPromise.current;
    const client = createApiClient({ baseUrl: API_BASE_URL, getAccessToken });
    const operation = Promise.all([
      drainCaptureOutbox({
        profileId,
        send: (capture) => client.createCapture(capture),
        store: sqliteCaptureOutboxStore
      }),
      drainCaptureDeleteIntents({
        profileId,
        send: (captureId, request) => client.deleteCapture(captureId, request),
        store: sqliteCaptureDeleteIntentStore
      })
    ])
      .then(async () => {
        scheduleWidgetPendingCount(await pendingCaptureCount(profileId));
      })
      .finally(() => {
        drainPromise.current = null;
      });
    drainPromise.current = operation;
    return operation;
  }, [getAccessToken, profileId]);

  useEffect(() => {
    if (profileId === null) return undefined;
    void resumeCaptureOutboxAfterSignIn(profileId)
      .then(drain)
      .catch(() => undefined);
    const timer = setInterval(() => void drain().catch(() => undefined), RETRY_TICK_MS);
    const unsubscribe = subscribeToCaptureOutboxDrain(() => void drain().catch(() => undefined));
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void drain().catch(() => undefined);
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
      subscription.remove();
    };
  }, [drain, profileId]);

  return drain;
}
