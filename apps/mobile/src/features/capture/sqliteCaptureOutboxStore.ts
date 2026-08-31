import {
  cancelCaptureDeletion,
  claimNextCapture,
  completeCaptureDeletion,
  listPendingCaptureDeleteIntents,
  markCaptureForRetry,
  markCapturePermanentFailure,
  markCaptureSynced,
  markCaptureWaitingForSignIn,
  recoverCaptureOutbox
} from "./captureDraftRepository";
import type { CaptureDeleteIntentStore } from "./captureActionCoordinator";
import type { CaptureOutboxStore } from "./captureOutboxCoordinator";

const store: CaptureOutboxStore = {
  claimNext: (profileId, now) => claimNextCapture(profileId, now),
  markPermanentFailure: (profileId, captureId, code) =>
    markCapturePermanentFailure(profileId, captureId, code),
  markRetry: (profileId, captureId, code, nextAttemptAt) =>
    markCaptureForRetry(profileId, captureId, code, nextAttemptAt),
  markSynced: (profileId, captureId, response, acknowledgedAt) =>
    markCaptureSynced(profileId, captureId, response, acknowledgedAt),
  markWaitingForSignIn: (profileId, captureId) => markCaptureWaitingForSignIn(profileId, captureId),
  recover: (profileId) => recoverCaptureOutbox(profileId)
};

export const sqliteCaptureOutboxStore = Object.freeze(store);

const deleteIntentStore: CaptureDeleteIntentStore = {
  cancel: (intent) =>
    cancelCaptureDeletion(intent.profileId, intent.actionSignature, intent.captureId),
  complete: (intent) =>
    completeCaptureDeletion(intent.profileId, intent.actionSignature, intent.captureId),
  list: listPendingCaptureDeleteIntents
};

export const sqliteCaptureDeleteIntentStore = Object.freeze(deleteIntentStore);
