import type { Metadata } from "next";
import Link from "next/link";

import { AuthForm } from "@/components/auth/auth-form";
import { BrandLogo } from "@/components/brand-logo";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your private Unfiled note library."
};

export default function AuthPage() {
  return (
    <main id="main-content" className="auth-page">
      <section className="auth-intro" aria-labelledby="auth-title">
        <BrandLogo />
        <div className="mt-auto max-w-xl pt-24">
          <p className="eyebrow">A place before a folder</p>
          <h1
            id="auth-title"
            className="mt-5 text-5xl font-semibold tracking-[-0.055em] sm:text-7xl"
          >
            Pick up where your thought left off.
          </h1>
          <p className="mt-6 max-w-md text-lg leading-8 text-muted-content">
            One private library across web and iPhone. Your notes stay yours; every manual change
            keeps a revision.
          </p>
        </div>
      </section>
      <section className="auth-panel" aria-label="Sign in form">
        <div className="w-full max-w-sm">
          <p className="eyebrow">Passwordless sign in</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-[-0.04em]">Continue to your notes</h2>
          <p className="mt-3 leading-7 text-muted-content">
            We’ll email a short-lived code. No password to remember.
          </p>
          <AuthForm />
          <p className="mt-8 border-t border-outline pt-5 text-sm leading-6 text-muted-content">
            By continuing, you agree to keep access to this email secure.{" "}
            <Link href="/" className="text-content underline decoration-outline underline-offset-4">
              Back home
            </Link>
            .
          </p>
        </div>
      </section>
    </main>
  );
}
