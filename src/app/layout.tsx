import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { HeaderWithUser, HeaderFallback } from '@/components/Header';
import { FlashMessage } from '@/components/FlashMessage';
import './app.css';

export const metadata: Metadata = {
  title: { default: 'Cebu Events', template: '%s · Cebu Events' },
  description: 'Free tech meetups, talks and hackathons in Cebu. Register online and bring your QR ticket to the door.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f8f7fc',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <svg className="icon-library" xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false">
          <symbol id="icon-calendar" viewBox="0 0 24 24">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M16 3v4M8 3v4M3 10h18" />
          </symbol>
          <symbol id="icon-pin" viewBox="0 0 24 24">
            <path d="M20 10c0 5-8 10-8 10s-8-5-8-10a8 8 0 1 1 16 0Z" />
            <circle cx="12" cy="10" r="2.5" />
          </symbol>
          <symbol id="icon-ticket" viewBox="0 0 24 24">
            <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6V7Z" />
            <path d="M14 8v1m0 3v1m0 3v1" />
          </symbol>
          <symbol id="icon-arrow" viewBox="0 0 24 24">
            <path d="M5 12h14m-6-6 6 6-6 6" />
          </symbol>
        </svg>

        <Suspense fallback={<HeaderFallback />}>
          <HeaderWithUser />
        </Suspense>

        <main id="main" className="wrap">
          <Suspense>
            <FlashMessage />
          </Suspense>
          {children}
        </main>

        <footer className="footer">
          <div className="wrap footer-inner">
            <Link href="/" className="footer-brand">
              Cebu Events
            </Link>
            <p>All times are Cebu time (UTC+8).</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
