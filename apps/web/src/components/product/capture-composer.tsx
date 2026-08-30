"use client";

import { ArrowUpIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import type { SubmitEvent } from "react";

export function CaptureComposer() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = inputRef.current;

    if (input === null || input.value.trim().length === 0) {
      setMessage("Write something before saving.");
      input?.focus();
      return;
    }

    input.value = "";
    setMessage("Captured in this preview.");
    input.focus();
  }

  return (
    <div>
      <form
        onSubmit={handleSubmit}
        className="flex min-h-16 items-center gap-3 rounded-frame border border-outline bg-panel px-3 sm:px-4"
      >
        <img
          src="/brand/unfiled-mark.svg"
          alt=""
          width="28"
          height="28"
          aria-hidden="true"
          className="shrink-0"
        />
        <span className="h-7 w-px shrink-0 bg-action" aria-hidden="true" />
        <label htmlFor="quick-capture" className="sr-only">
          Write something
        </label>
        <input
          ref={inputRef}
          id="quick-capture"
          name="capture"
          type="text"
          autoComplete="off"
          placeholder="Write something"
          className="min-w-0 flex-1 bg-transparent px-1 py-4 text-base text-content placeholder:text-muted-content focus:outline-none"
        />
        <button
          type="submit"
          aria-label="Save capture"
          className="flex size-11 shrink-0 items-center justify-center rounded-control bg-action text-action-contrast transition-transform active:translate-y-px"
        >
          <ArrowUpIcon size={21} weight="bold" aria-hidden="true" />
        </button>
      </form>
      <p aria-live="polite" className="min-h-6 pt-2 text-sm text-muted-content">
        {message}
      </p>
    </div>
  );
}
