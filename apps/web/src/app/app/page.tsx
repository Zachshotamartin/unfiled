import type { Metadata } from "next";

import { InboxView } from "@/components/product/inbox-view";

export const metadata: Metadata = {
  title: "Inbox",
  description: "Write something down and see everything that still needs you."
};

/**
 * The Inbox (ADR-0019, decision 6): where thoughts land. The capture card first, then only what
 * needs the owner — review decisions as cards with their actions inline, and captures that are
 * still organizing, failed, or stopped. Filed captures are notes in the Library.
 */
export default function InboxPage() {
  return (
    <main id="main-content" className="product-page">
      <div className="content-column">
        <InboxView />
      </div>
    </main>
  );
}
