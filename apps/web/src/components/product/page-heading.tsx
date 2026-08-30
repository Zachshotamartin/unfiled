import type { ReactNode } from "react";

export function PageHeading({
  action,
  eyebrow,
  title
}: Readonly<{ action?: ReactNode; eyebrow?: string; title: string }>) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
        <h1 className={eyebrow === undefined ? "" : "mt-4"}>{title}</h1>
      </div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </header>
  );
}
