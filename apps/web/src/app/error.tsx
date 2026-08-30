"use client";

import { ArrowClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  return (
    <main
      id="main-content"
      className="flex min-h-[100dvh] items-center justify-center bg-page px-4 py-16"
    >
      <section
        aria-labelledby="error-title"
        className="w-full max-w-lg border-t border-outline pt-8"
      >
        <WarningCircleIcon size={32} weight="regular" className="text-action" aria-hidden="true" />
        <h1 id="error-title" className="mt-6 text-4xl font-semibold tracking-[-0.045em]">
          This page did not load.
        </h1>
        <p className="mt-4 leading-7 text-muted-content">
          Your notes were not changed. Try loading this view again.
        </p>
        {error.digest === undefined ? null : (
          <p className="mt-3 font-mono text-xs text-muted-content">Reference {error.digest}</p>
        )}
        <button type="button" onClick={reset} className="button-primary mt-7">
          Try again
          <ArrowClockwiseIcon size={17} weight="bold" aria-hidden="true" />
        </button>
      </section>
    </main>
  );
}
