import type { ReactNode } from "react";

/** The one screen header: an optional eyebrow, the title, an optional count, a trailing control. */
export function PageHeading({
  action,
  eyebrow,
  subtitle,
  title
}: Readonly<{
  action?: ReactNode;
  eyebrow?: string;
  subtitle?: string | undefined;
  title: string;
}>) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
        <h1 className={eyebrow === undefined ? "" : "mt-4"}>{title}</h1>
        {subtitle === undefined ? null : <p className="page-subtitle">{subtitle}</p>}
      </div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </header>
  );
}
