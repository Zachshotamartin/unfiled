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
      {/* The panel names itself: its heading changes when a new account has a code to confirm. */}
      <section className="auth-panel" aria-labelledby="auth-panel-title">
        <div className="w-full max-w-sm">
          <AuthForm />
          <p className="mt-8 border-t border-outline pt-5 text-sm leading-6 text-muted-content">
            By continuing, you agree to keep your password private.{" "}
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
