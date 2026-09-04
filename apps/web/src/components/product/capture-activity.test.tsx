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
    expect(html).toContain("OpenAI or Claude key");
    expect(html).toContain('href="/app/settings"');
    expect(html).toContain("Encrypted capture saved on this device.");
    expect(html).not.toContain("private local words");
  });

  it("renders retry and detail actions only when their backing state allows them", () => {
    const stoppedId = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
    const html = renderToStaticMarkup(
      <CaptureActivity
        error={null}
        items={[
          activity({ status: "permanent" }),
          activity({
            id: stoppedId,
            local: false,
            preview: "buy oat milk",
            receiptAvailable: true,
            serverAvailable: true,
            status: "needs_review"
          })
        ]}
        loading={false}
        onRetryLocal={vi.fn()}
        onRetryRemote={vi.fn()}
      />
    );

    expect(html).toContain("Retry");
    expect(html).toContain(`/app/captures/${stoppedId}`);
    expect(html).toContain("buy oat milk");
  });

  it("holds only what needs the owner, so a filed capture never lingers in the Inbox", () => {
    const filedId = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1Z";
    const html = renderToStaticMarkup(
      <CaptureActivity
        error={null}
        items={[
          activity({
            id: filedId,
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

    // ADR-0019, decision 9: a filed capture is a note in the Library, so nothing is left behind
    // in the Inbox when that note is deleted.
    expect(html).not.toContain(`/app/captures/${filedId}`);
    expect(html).not.toContain("buy oat milk");
    expect(html).toContain("Everything you wrote is filed in your Library.");
  });

  it("reports the provider outage only while a capture is still waiting on it", () => {
    const html = renderToStaticMarkup(
      <CaptureActivity
        error={null}
        items={[activity({ errorCode: "provider_unavailable", local: false, status: "done" })]}
        loading={false}
        onRetryLocal={vi.fn()}
        onRetryRemote={vi.fn()}
      />
    );

    expect(html).not.toContain("The AI provider is unavailable");
  });

  it("names what needs the owner and lists the review decisions with it", () => {
    const html = renderToStaticMarkup(
      <CaptureActivity
        error={null}
        items={[]}
        loading={false}
        onRetryLocal={vi.fn()}
        onRetryRemote={vi.fn()}
        reviewDecisions={<p>one open decision</p>}
        reviewDecisionsEmpty={false}
      />
    );

    expect(html).toContain("Needs you");
    expect(html).toContain("one open decision");
    // The two lists come from two endpoints; "nothing waiting" is only true of both at once.
    expect(html).not.toContain("Everything you wrote is filed in your Library.");
  });
});
