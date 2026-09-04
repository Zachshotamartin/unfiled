import { PageHeading } from "@/components/product/page-heading";

/** Settings' shape while it loads: heading, then rows of a label beside its controls. */
export default function SettingsLoading() {
  return (
    <main id="main-content" aria-busy="true" aria-label="Loading Settings" className="product-page">
      <div className="content-column">
        <PageHeading title="Settings" />
        <section className="mt-12 border-t border-outline" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="settings-row">
              <div>
                <div className="skeleton-block h-5 w-36" />
                <div className="skeleton-block mt-2 h-4 w-64 max-w-full" />
              </div>
              <div className="skeleton-block h-11 w-40 rounded-control" />
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
