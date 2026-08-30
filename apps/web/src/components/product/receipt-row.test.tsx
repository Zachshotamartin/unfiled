import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReceiptRow } from "./receipt-row";

describe("ReceiptRow", () => {
  it("renders the outcome, source detail, destination, and machine-readable time", () => {
    const markup = renderToStaticMarkup(
      <ReceiptRow
        receipt={{
          id: "shopping",
          time: "9:41 AM",
          machineTime: "2026-08-30T09:41:00-07:00",
          outcome: "Added to Shopping",
          detail: "Milk, eggs, bread",
          destination: "Shopping",
          selected: false
        }}
      />
    );

    expect(markup).toContain("Added to Shopping");
    expect(markup).toContain("Milk, eggs, bread");
    expect(markup).toContain('dateTime="2026-08-30T09:41:00-07:00"');
    expect(markup).toContain('aria-label="Undo Added to Shopping"');
  });
});
