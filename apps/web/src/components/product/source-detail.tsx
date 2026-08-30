import { ArrowSquareOutIcon } from "@phosphor-icons/react/ssr";

export function SourceDetail() {
  return (
    <div id="source-detail">
      <h2 className="balanced text-3xl leading-9 font-semibold tracking-[-0.04em]">
        Added to Mindset
      </h2>
      <div className="mt-8 border-t border-outline pt-7">
        <p className="font-mono text-xs text-muted-content">Original capture</p>
        <p className="pretty mt-3 text-lg leading-7 text-content">
          Roosevelt method: tell people you can do it, then figure out how
        </p>
      </div>
      <div className="mt-8">
        <p className="font-mono text-xs text-muted-content">Destination</p>
        <p className="mt-3 font-mono text-base text-content">Mindset / Principles</p>
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          disabled
          className="button-primary disabled:cursor-not-allowed disabled:opacity-70"
        >
          Open note
          <ArrowSquareOutIcon size={17} weight="bold" aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled
          className="button-secondary disabled:cursor-not-allowed disabled:text-disabled-content"
        >
          Undo
        </button>
      </div>
      <div className="mt-8 border-t border-outline pt-7">
        <p className="text-sm font-medium text-content">Original preserved</p>
        <p className="pretty mt-2 text-sm leading-6 text-muted-content">
          The source stays attached to every organized change.
        </p>
      </div>
    </div>
  );
}
