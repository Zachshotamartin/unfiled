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
          background: "#f3f4f6",
          color: "#14171b",
          fontFamily: "system-ui, sans-serif"
        }}
      >
        <main style={{ display: "grid", minHeight: "100dvh", placeItems: "center", padding: 24 }}>
          <section style={{ maxWidth: 520, borderTop: "1px solid #dde1e6", paddingTop: 32 }}>
            <h1
              style={{
                margin: 0,
                fontFamily: 'ui-serif, "New York", Georgia, serif',
                fontSize: 42,
                fontWeight: 600,
                letterSpacing: "-0.02em"
              }}
            >
              Unfiled could not open.
            </h1>
            <p style={{ color: "#626b76", lineHeight: 1.6 }}>
              Your notes were not changed. Reload the application to try again.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: 44,
                border: 0,
                borderRadius: 13,
                background: "#1e6b57",
                color: "#f3f4f6",
                padding: "12px 18px",
                fontWeight: 600
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
