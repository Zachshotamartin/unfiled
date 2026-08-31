import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CaptureActivityItem, CaptureActivityStatus } from "@/lib/capture/capture-queue";

import { CaptureActivity, captureStatusLabel } from "./capture-activity";

const CAPTURE_ID = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X";

function activity(overrides: Partial<CaptureActivityItem> = {}): CaptureActivityItem {
  return {
    clientCreatedAt: "2026-08-30T18:30:00.000Z",
    errorCode: null,
    id: CAPTURE_ID,
    local: true,
    preview: null,
    receiptAvailable: false,
    serverAvailable: false,
    status: "waiting",
    ...overrides
  };
}

describe("CaptureActivity", () => {
  it("labels every durable client and server state", () => {
    const cases: readonly (readonly [CaptureActivityStatus, string])[] = [
      ["waiting", "Waiting to sync"],
      ["sending", "Syncing"],
      ["retrying", "Waiting to retry"],
      ["permanent", "Needs retry"],
      ["queued", "Queued"],
      ["processing", "Organizing"],
      ["done", "Done"],
      ["needs_review", "Needs review"],
      ["failed", "Failed"],
      ["inbox", "Safe in Inbox"]
    ];

    expect(cases.map((entry) => captureStatusLabel(entry[0]))).toEqual(
      cases.map((entry) => entry[1])
    );
  });

  it("shows provider outage truth for a retrying capture and never reveals its local plaintext", () => {
    const html = renderToStaticMarkup(
      <CaptureActivity
        error={null}
        items={[
          activity({
            errorCode: "provider_unavailable",
            status: "retrying"
          })
        ]}
        loading={false}
        onRetryLocal={vi.fn()}
        onRetryRemote={vi.fn()}
      />
    );

    expect(html).toContain("Encrypted captures remain queued or safe in Inbox");
    expect(html).toContain("Encrypted capture saved on this device.");
    expect(html).not.toContain("private local words");
  });

  it("renders retry and detail actions only when their backing state allows them", () => {
    const syncedId = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
    const html = renderToStaticMarkup(
      <CaptureActivity
        error={null}
        items={[
          activity({ status: "permanent" }),
          activity({
            id: syncedId,
            local: false,
            preview: "buy oat milk",
            receiptAvailable: true,
            serverAvailable: true,
            status: "done"
          })
        ]}
        loading={false}
        onRetryLocal={vi.fn()}
        onRetryRemote={vi.fn()}
      />
    );

    expect(html).toContain("Retry");
    expect(html).toContain(`/app/captures/${syncedId}`);
    expect(html).toContain("buy oat milk");
  });
});
