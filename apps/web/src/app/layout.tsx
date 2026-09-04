import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

const geistSans = Geist({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-geist-sans"
});

const geistMono = Geist_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-geist-mono"
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Unfiled | Notes that organize themselves",
    template: "%s | Unfiled"
  },
  description:
    "Capture a thought without choosing a title or folder. Unfiled finds the useful note, shows every change, and preserves your original.",
  applicationName: "Unfiled",
  keywords: ["notes", "capture", "organization", "iPhone notes", "personal notes"],
  authors: [{ name: "Unfiled" }],
  creator: "Unfiled",
  openGraph: {
    type: "website",
    siteName: "Unfiled",
    title: "Just write. It finds its place.",
    description: "Capture-first notes that organize after you write.",
    url: "/"
  },
  twitter: {
    card: "summary_large_image",
    title: "Just write. It finds its place.",
    description: "Capture-first notes that organize after you write."
  }
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f3f4f6",
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      data-scroll-behavior="smooth"
    >
      <body>
        <a
          href="#main-content"
          className="fixed top-3 left-3 z-50 -translate-y-24 rounded-control bg-action px-4 py-3 font-semibold text-action-contrast transition-transform focus:translate-y-0"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
