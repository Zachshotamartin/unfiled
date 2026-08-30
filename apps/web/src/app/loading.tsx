export default function Loading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      aria-label="Loading Unfiled"
      className="min-h-[100dvh] bg-page px-4 py-8 sm:px-6 lg:px-10"
    >
      <div className="mx-auto max-w-[1440px]">
        <div className="flex h-14 items-center justify-between">
          <div className="skeleton-block h-8 w-32 rounded-control" />
          <div className="skeleton-block h-11 w-36 rounded-control" />
        </div>
        <div className="mt-16 grid gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:items-center">
          <div>
            <div className="skeleton-block h-16 w-full max-w-lg rounded-control" />
            <div className="skeleton-block mt-4 h-16 w-4/5 max-w-md rounded-control" />
            <div className="skeleton-block mt-8 h-6 w-72 max-w-full rounded-control" />
            <div className="skeleton-block mt-8 h-11 w-40 rounded-control" />
          </div>
          <div className="skeleton-block aspect-[5/4] w-full rounded-frame" />
        </div>
      </div>
    </main>
  );
}
