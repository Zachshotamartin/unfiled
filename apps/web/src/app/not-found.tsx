import Link from "next/link";

import { BrandLogo } from "@/components/brand-logo";

export default function NotFound() {
  return (
    <main
      id="main-content"
      className="flex min-h-[100dvh] flex-col bg-page px-4 py-7 sm:px-6 lg:px-10"
    >
      <BrandLogo />
      <section
        aria-labelledby="not-found-title"
        className="my-auto mx-auto w-full max-w-2xl border-t border-outline py-10"
      >
        <p className="font-mono text-sm text-action">404</p>
        <h1
          id="not-found-title"
          className="balanced mt-5 text-5xl leading-none font-semibold tracking-[-0.055em] sm:text-7xl"
        >
          This note has no place yet.
        </h1>
        <p className="pretty mt-6 max-w-lg text-lg leading-7 text-muted-content">
          The page may have moved, or the address may be incomplete.
        </p>
        <Link href="/" className="button-primary mt-8">
          Back home
        </Link>
      </section>
    </main>
  );
}
