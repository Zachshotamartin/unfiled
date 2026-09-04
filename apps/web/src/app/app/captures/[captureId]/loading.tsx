/** A capture's receipt while it loads: the way back, the outcome, the words, the receipt. */
export default function CaptureLoading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      aria-label="Loading the capture"
      className="capture-detail-page"
    >
      <div className="capture-detail-column" aria-hidden="true">
        <div className="skeleton-block h-5 w-20" />
        <div className="skeleton-block mt-8 h-3 w-24" />
        <div className="skeleton-block mt-3 h-10 w-2/3 max-w-full rounded-control" />
        <div className="mt-8 grid gap-3">
          <div className="skeleton-block h-5 w-full" />
          <div className="skeleton-block h-5 w-5/6" />
        </div>
        <div className="skeleton-block mt-10 h-32 w-full rounded-frame" />
      </div>
    </main>
  );
}
