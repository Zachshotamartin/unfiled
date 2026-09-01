import { describe, expect, it } from "vitest";

import { createOrganizerComposition } from "../src/composition.js";
import { loadOrganizerConfig } from "../src/config.js";

describe("organizer composition", () => {
  it("builds and closes the fail-closed local deployment composition", async () => {
    const composition = createOrganizerComposition(
      loadOrganizerConfig({
        UNFILED_ORGANIZER_DRAIN_SECRET: "local-secret-at-least-thirty-two-characters",
        UNFILED_ORGANIZER_ENV: "local"
      })
    );
    const health = await composition.app(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ service: "unfiled-organizer", status: "ok" });
    await expect(composition.close()).resolves.toBeUndefined();
  });
});
