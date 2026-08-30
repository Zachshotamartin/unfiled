"use client";

interface GlobalErrorProps {
  reset: () => void;
}

export default function GlobalError({ reset }: GlobalErrorProps) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#0B0C0E",
          color: "#F2EFE8",
          fontFamily: "system-ui, sans-serif"
        }}
      >
        <main style={{ display: "grid", minHeight: "100dvh", placeItems: "center", padding: 24 }}>
          <section
            style={{ maxWidth: 520, borderTop: "1px solid rgba(242,239,232,.14)", paddingTop: 32 }}
          >
            <h1 style={{ margin: 0, fontSize: 42, letterSpacing: "-0.04em" }}>
              Unfiled could not open.
            </h1>
            <p style={{ color: "#9DA3A6", lineHeight: 1.6 }}>
              Your notes were not changed. Reload the application to try again.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: 44,
                border: 0,
                borderRadius: 10,
                background: "#EE6F55",
                color: "#0B0C0E",
                padding: "12px 18px",
                fontWeight: 700
              }}
            >
              Reload
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
