import { createApiClient } from "@unfiled/api-client";
import type {
  ApiErrorCodeValue,
  CaptureProcessingState,
  CaptureSummary,
  PrivacyMode
} from "@unfiled/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";

import { useSession } from "../../auth/AuthProvider";
import {
  getOrCreateCaptureRetryIntent,
  listCaptureOutbox,
  removeCaptureActionIntent,
  retryCapture as retryLocalCapture
} from "./captureDraftRepository";
import { requestCaptureOutboxDrain } from "./captureOutboxSignals";
import type { CaptureOutboxRecord, CaptureOutboxState } from "./captureOutboxTypes";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3000";
const REFRESH_INTERVAL_MS = 4_000;

export type CaptureActivityState = CaptureProcessingState | Exclude<CaptureOutboxState, "synced">;

export interface CaptureActivityItem {
  clientCreatedAt: string;
  id: `cap_${string}`;
  lastErrorCode: ApiErrorCodeValue | null;
  privacy: PrivacyMode;
  rawContentPreview: string;
  receiptAvailable: boolean;
  state: CaptureActivityState;
}

interface CaptureActivityResource {
  error: string | null;
  items: CaptureActivityItem[];
  loading: boolean;
  refresh: () => Promise<void>;
  retry: (captureId: `cap_${string}`) => Promise<void>;
}

function preview(value: string): string {
  return value.length <= 280 ? value : `${value.slice(0, 277)}...`;
}

function localState(state: CaptureOutboxState): CaptureActivityState {
  return state === "synced" ? "queued" : state;
}

function fromLocal(entry: CaptureOutboxRecord): CaptureActivityItem {
  return {
    clientCreatedAt: entry.capture.clientCreatedAt,
    id: entry.capture.clientCaptureId,
    lastErrorCode: entry.lastErrorCode,
    privacy: entry.capture.privacy,
    rawContentPreview: preview(entry.capture.rawContent),
    receiptAvailable: false,
    state: localState(entry.state)
  };
}

function fromServer(capture: CaptureSummary): CaptureActivityItem {
  return {
    clientCreatedAt: capture.clientCreatedAt,
    id: capture.id,
    lastErrorCode: capture.lastErrorCode,
    privacy: capture.privacy,
    rawContentPreview: capture.rawContentPreview,
    receiptAvailable: capture.receiptAvailable,
    state: capture.status
  };
}

function mergeActivity(
  local: readonly CaptureOutboxRecord[],
  server: readonly CaptureSummary[]
): CaptureActivityItem[] {
  const byId = new Map<`cap_${string}`, CaptureActivityItem>();
  for (const entry of local) byId.set(entry.capture.clientCaptureId, fromLocal(entry));
  for (const capture of server) byId.set(capture.id, fromServer(capture));
  return [...byId.values()].sort(
    (left, right) => Date.parse(right.clientCreatedAt) - Date.parse(left.clientCreatedAt)
  );
}

export function useCaptureActivity(): CaptureActivityResource {
  const { getAccessToken, session } = useSession();
  const profileId = session?.user.id ?? null;
  const api = useMemo(
    () => (session === null ? null : createApiClient({ baseUrl: API_BASE_URL, getAccessToken })),
    [getAccessToken, session]
  );
  const [items, setItems] = useState<CaptureActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (profileId === null) {
      setItems([]);
      setLoading(false);
      return;
    }
    const [localResult, serverResult] = await Promise.allSettled([
      listCaptureOutbox(profileId),
      api?.listCaptures({ limit: 30 }) ?? Promise.resolve({ items: [] })
    ]);
    if (localResult.status === "rejected") {
      setError("Encrypted capture storage is unavailable.");
      setLoading(false);
      return;
    }
    const serverItems = serverResult.status === "fulfilled" ? serverResult.value.items : [];
    setItems(mergeActivity(localResult.value, serverItems));
    setError(
      serverResult.status === "rejected" ? "Capture status will refresh when online." : null
    );
    setLoading(false);
  }, [api, profileId]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  useEffect(() => {
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [refresh]);

  const retry = useCallback(
    async (captureId: `cap_${string}`): Promise<void> => {
      if (profileId === null) return;
      const item = items.find(({ id }) => id === captureId);
      try {
        if (item?.state === "permanent_failure") {
          await retryLocalCapture(profileId, captureId);
          requestCaptureOutboxDrain();
        } else if (item?.state === "failed" && api !== null) {
          const detail = (await api.getCapture(captureId)).capture;
          const intent = await getOrCreateCaptureRetryIntent(
            profileId,
            captureId,
            detail.receipt?.createdAt ?? detail.receivedAt
          );
          await api.retryCapture(captureId, intent.request);
          await removeCaptureActionIntent(profileId, intent.actionSignature);
        }
        await refresh();
      } catch {
        setError("Couldn't retry this capture yet.");
      }
    },
    [api, items, profileId, refresh]
  );

  return { error, items, loading, refresh, retry };
}
