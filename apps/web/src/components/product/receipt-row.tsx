import type { ReceiptFixture } from "@/lib/app-fixtures";

interface ReceiptRowProps {
  receipt: ReceiptFixture;
}

export function ReceiptRow({ receipt }: ReceiptRowProps) {
  return (
    <article
      id={`receipt-${receipt.id}`}
      aria-labelledby={`receipt-${receipt.id}-title`}
      className="grid gap-3 border-b border-outline py-6 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto] sm:gap-5"
    >
      <time dateTime={receipt.machineTime} className="font-mono text-sm text-muted-content">
        {receipt.time}
      </time>
      <div className="min-w-0">
        <div className="flex items-start gap-3">
          <span className="mt-1.5 h-4 w-2 shrink-0 -rotate-12 bg-action" aria-hidden="true" />
          <div className="min-w-0">
            <h2
              id={`receipt-${receipt.id}-title`}
              className="text-lg leading-6 font-semibold text-content"
            >
              {receipt.outcome}
            </h2>
            <p className="pretty mt-2 font-mono text-[15px] leading-6 text-content">
              {receipt.detail}
            </p>
            <p className="mt-2 text-sm text-muted-content">{receipt.destination}</p>
          </div>
        </div>
      </div>
      <button
        type="button"
        disabled
        aria-label={`Undo ${receipt.outcome}`}
        className="w-fit self-start rounded-control px-2 py-1 text-sm text-disabled-content disabled:cursor-not-allowed"
      >
        Undo
      </button>
    </article>
  );
}
