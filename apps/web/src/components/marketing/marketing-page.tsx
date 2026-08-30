import { ArrowRightIcon } from "@phosphor-icons/react/ssr";
import Image from "next/image";
import Link from "next/link";

import heroImage from "../../../../../design/brand/web/01-hero.png";
import noFilingImage from "../../../../../design/brand/web/02-no-filing.png";
import howItWorksImage from "../../../../../design/brand/web/03-how-it-works.png";
import useCasesImage from "../../../../../design/brand/web/04-use-cases.png";
import trustImage from "../../../../../design/brand/web/05-trust.png";
import finalCtaImage from "../../../../../design/brand/web/06-final-cta.png";

import { BrandLogo } from "@/components/brand-logo";
import { SiteHeader } from "@/components/site-header";

const waitlistHref = "mailto:hello@unfiled.app?subject=Unfiled%20waitlist";

export function MarketingPage() {
  return (
    <div className="min-h-[100dvh] bg-page text-content">
      <SiteHeader />

      <main id="main-content">
        <section
          aria-labelledby="hero-title"
          className="mx-auto grid min-h-[calc(100dvh-72px)] max-w-[1440px] items-center gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,0.82fr)_minmax(32rem,1.18fr)] lg:px-10 lg:py-12"
        >
          <div className="max-w-[39rem]">
            <h1
              id="hero-title"
              className="balanced text-[clamp(3.15rem,6.3vw,6.5rem)] leading-[0.91] font-semibold tracking-[-0.065em]"
            >
              <span className="block">Just write.</span>
              <span className="block">It finds its place.</span>
            </h1>
            <p className="pretty mt-6 max-w-[33rem] text-lg leading-7 text-muted-content sm:text-xl">
              Capture a thought now. Unfiled organizes it after.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href={waitlistHref} className="button-primary">
                Join the waitlist
                <ArrowRightIcon size={18} weight="bold" aria-hidden="true" />
              </a>
              <Link href="/app" className="button-secondary">
                View the app
              </Link>
            </div>
          </div>

          <figure className="marketing-frame relative aspect-[5/4] min-h-0 w-full">
            <Image
              src={heroImage}
              alt="An Unfiled phone capture screen surrounded by loose paper notes moving toward the intake mark"
              fill
              priority
              placeholder="blur"
              sizes="(max-width: 1023px) 100vw, 58vw"
              className="object-cover object-[64%_75%]"
            />
          </figure>
        </section>

        <section
          id="product"
          aria-labelledby="problem-title"
          className="border-t border-outline py-20 sm:py-28 lg:py-36"
        >
          <div className="mx-auto grid max-w-[1440px] gap-10 px-4 sm:px-6 md:grid-cols-[0.72fr_1.28fr] md:items-center lg:px-10">
            <div className="max-w-[29rem]">
              <h2
                id="problem-title"
                className="balanced text-5xl leading-[0.98] font-semibold tracking-[-0.055em] sm:text-6xl"
              >
                No titles. No folders. No filing first.
              </h2>
              <p className="pretty mt-6 text-lg leading-7 text-muted-content">
                Start with the thought. The structure can wait.
              </p>
            </div>
            <figure className="marketing-frame relative aspect-[16/10] w-full">
              <Image
                src={noFilingImage}
                alt="Loose notes for milk, a workout, and a mindset idea being sorted into useful destinations"
                fill
                placeholder="blur"
                sizes="(max-width: 767px) 100vw, 65vw"
                className="object-cover"
              />
            </figure>
          </div>
        </section>

        <section
          aria-labelledby="mechanism-title"
          className="border-t border-outline py-20 sm:py-28 lg:py-36"
        >
          <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-10">
            <div className="max-w-[50rem]">
              <h2
                id="mechanism-title"
                className="balanced text-5xl leading-[0.98] font-semibold tracking-[-0.055em] sm:text-7xl"
              >
                One thought in. One useful note out.
              </h2>
              <p className="pretty mt-6 max-w-[38rem] text-lg leading-7 text-muted-content">
                Capture once. See where it went and what changed.
              </p>
            </div>
            <figure className="marketing-frame relative mt-12 aspect-[16/9] w-full sm:mt-16">
              <Image
                src={howItWorksImage}
                alt="A capture moving through placement into a confirmed Shopping note with the original text preserved"
                fill
                placeholder="blur"
                sizes="(max-width: 1439px) 100vw, 1400px"
                className="object-cover"
              />
            </figure>
          </div>
        </section>

        <section
          aria-labelledby="breadth-title"
          className="border-t border-outline py-20 sm:py-28 lg:py-36"
        >
          <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-10">
            <h2
              id="breadth-title"
              className="balanced max-w-[70rem] text-[clamp(3.1rem,7vw,7.8rem)] leading-[0.9] font-semibold tracking-[-0.065em]"
            >
              Whatever is on your mind.
            </h2>
            <p className="pretty mt-6 max-w-[40rem] text-lg leading-7 text-muted-content">
              Lists, logs, ideas, and plans share one calm inbox.
            </p>
            <figure className="marketing-frame relative mt-10 aspect-[16/9] w-full sm:mt-14">
              <Image
                src={useCasesImage}
                alt="Four Unfiled note destinations for shopping, workouts, mindset, and projects"
                fill
                placeholder="blur"
                sizes="(max-width: 1439px) 100vw, 1400px"
                className="object-cover"
              />
            </figure>
          </div>
        </section>

        <section
          id="principles"
          aria-labelledby="trust-title"
          className="border-t border-outline py-20 sm:py-28 lg:py-36"
        >
          <div className="mx-auto grid max-w-[1440px] gap-10 px-4 sm:px-6 md:grid-cols-[1.2fr_0.8fr] md:items-center lg:px-10">
            <figure className="marketing-frame relative aspect-[16/10] w-full md:order-1">
              <Image
                src={trustImage}
                alt="An original handwritten Mindset note beside its organized version, with change and undo history visible"
                fill
                placeholder="blur"
                sizes="(max-width: 767px) 100vw, 62vw"
                className="object-cover"
              />
            </figure>
            <div className="max-w-[31rem] md:order-2 md:justify-self-end">
              <h2
                id="trust-title"
                className="balanced text-5xl leading-[0.98] font-semibold tracking-[-0.055em] sm:text-6xl"
              >
                Nothing happens behind your back.
              </h2>
              <p className="pretty mt-6 text-lg leading-7 text-muted-content">
                Your original stays close. Every change is visible. Undo is always available.
              </p>
            </div>
          </div>
        </section>

        <section
          id="join"
          aria-labelledby="join-title"
          className="border-t border-outline pt-20 sm:pt-28 lg:pt-36"
        >
          <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-10">
            <div className="mx-auto max-w-[58rem] text-center">
              <h2
                id="join-title"
                className="balanced text-[clamp(3.1rem,7vw,7.5rem)] leading-[0.92] font-semibold tracking-[-0.065em]"
              >
                Write it down before it disappears.
              </h2>
              <a href={waitlistHref} className="button-primary mt-8">
                Join the waitlist
                <ArrowRightIcon size={18} weight="bold" aria-hidden="true" />
              </a>
            </div>
            <figure className="marketing-frame relative mx-auto mt-12 aspect-[4/3] w-full max-w-[72rem] sm:mt-16 sm:aspect-[16/5]">
              <Image
                src={finalCtaImage}
                alt="A paper thought settling into the open Unfiled intake tray"
                fill
                placeholder="blur"
                sizes="(max-width: 1151px) 100vw, 1152px"
                className="object-cover object-bottom"
              />
            </figure>
          </div>

          <footer className="mt-20 border-t border-outline sm:mt-28">
            <div className="mx-auto flex max-w-[1440px] flex-col gap-8 px-4 py-9 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-10">
              <BrandLogo />
              <nav
                aria-label="Footer navigation"
                className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-muted-content"
              >
                <a href="#product" className="rounded-control py-2 hover:text-content">
                  Product
                </a>
                <a href="#principles" className="rounded-control py-2 hover:text-content">
                  Principles
                </a>
                <Link href="/app" className="rounded-control py-2 hover:text-content">
                  Open app
                </Link>
              </nav>
              <p className="text-sm text-muted-content">Web + iPhone</p>
            </div>
          </footer>
        </section>
      </main>
    </div>
  );
}
