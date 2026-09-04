export default function AppLoading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      aria-label="Loading your Inbox"
      className="min-h-[100dvh] bg-page px-4 py-10 sm:px-8 lg:px-12"
    >
      <div className="mx-auto max-w-[760px]">
        <div className="skeleton-block h-14 w-44 rounded-control" />
        <div className="skeleton-block mt-4 h-5 w-48 rounded-control" />
        <div className="skeleton-block mt-10 h-16 w-full rounded-frame" />
        <div className="mt-8 border-t border-outline">
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              className="grid gap-4 border-b border-outline py-7 sm:grid-cols-[7rem_1fr]"
            >
              <div className="skeleton-block h-5 w-20 rounded-control" />
              <div>
                <div className="skeleton-block h-6 w-52 max-w-full rounded-control" />
                <div className="skeleton-block mt-3 h-5 w-72 max-w-full rounded-control" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
