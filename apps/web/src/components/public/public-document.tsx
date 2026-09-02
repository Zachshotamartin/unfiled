import type { ReactNode } from "react";

import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/site-header";

export interface PublicDocumentNavigationItem {
  href: `#${string}`;
  label: string;
}

interface PublicDocumentProps {
  children: ReactNode;
  eyebrow: string;
  navigation: readonly PublicDocumentNavigationItem[];
  summary: string;
  title: string;
  updated?: string;
}

export function PublicDocument({
  children,
  eyebrow,
  navigation,
  summary,
  title,
  updated = "September 2, 2026"
}: Readonly<PublicDocumentProps>) {
  return (
    <div className="min-h-[100dvh] bg-page text-content">
      <SiteHeader />
      <main id="main-content">
        <header className="border-b border-outline">
          <div className="mx-auto max-w-[1440px] px-4 py-16 sm:px-6 sm:py-24 lg:px-10">
            <p className="section-label text-action">{eyebrow}</p>
            <h1 className="balanced mt-5 max-w-5xl text-[clamp(3.25rem,7.5vw,7.5rem)] leading-[0.9] font-semibold tracking-[-0.065em]">
              {title}
            </h1>
            <p className="pretty mt-7 max-w-2xl text-lg leading-8 text-muted-content sm:text-xl">
              {summary}
            </p>
            <p className="mt-8 font-mono text-xs tracking-[0.08em] text-muted-content uppercase">
              Last updated {updated}
            </p>
          </div>
        </header>

        <div className="mx-auto grid max-w-[1440px] gap-12 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[16rem_minmax(0,48rem)] lg:gap-20 lg:px-10 lg:py-24">
          <aside className="self-start lg:sticky lg:top-28">
            <p className="section-label">On this page</p>
            <nav aria-label={`${title} sections`} className="mt-4 grid gap-1">
              {navigation.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="border-l border-outline px-4 py-2 text-sm leading-5 text-muted-content transition-colors hover:border-action hover:text-content"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </aside>

          <article className="public-document">{children}</article>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

interface PublicSectionProps {
  children: ReactNode;
  id: string;
  title: string;
}

export function PublicSection({ children, id, title }: Readonly<PublicSectionProps>) {
  return (
    <section id={id} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}

export function PublicCallout({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="public-callout">{children}</div>;
}
