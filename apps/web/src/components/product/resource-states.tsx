import type { ReactNode } from "react";

import { UnfiledGlyph } from "./unfiled-glyph";

export function ResourceSkeleton({ rows = 4 }: Readonly<{ rows?: number }>) {
  return (
    <div aria-busy="true" aria-label="Loading" className="border-t border-outline">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="note-row" aria-hidden="true">
          <div className="skeleton-block h-3 w-20" />
          <div className="skeleton-block mt-4 h-6 w-64 max-w-[80%]" />
          <div className="skeleton-block mt-3 h-4 w-40" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  action,
  body,
  title
}: Readonly<{ action?: ReactNode; body: string; title: string }>) {
  return (
    // An empty state is a sentence and, at most, one action. Never an illustration or a logo.
    <section className="empty-state" aria-labelledby="empty-title">
      <h2 id="empty-title">{title}</h2>
      <p className="mt-3 max-w-md leading-7 text-muted-content">{body}</p>
      {action === undefined ? null : <div className="mt-6">{action}</div>}
    </section>
  );
}

export function ResourceError({
  message,
  offline = false,
  retry
}: Readonly<{ message: string; offline?: boolean; retry: () => void }>) {
  return (
    <section className="empty-state" role="alert">
      <UnfiledGlyph
        glyph={offline ? "warning" : "undo"}
        size={29}
        weight={1.9}
        className="text-action"
      />
      <h2 className="mt-5">{offline ? "You’re offline." : "This view didn’t load."}</h2>
      <p className="mt-3 max-w-md leading-7 text-muted-content">{message}</p>
      <button type="button" className="button-secondary mt-6" onClick={retry}>
        <UnfiledGlyph glyph="undo" size={17} weight={1.9} /> Try again
      </button>
    </section>
  );
}
