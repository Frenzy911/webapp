'use client';

import Link from 'next/link';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card form-card">
      <h1>Something went wrong</h1>
      <p>Something went wrong on our side. Please try again.</p>
      {error.digest && <p className="muted small">Reference: {error.digest}</p>}
      <p>
        <button className="btn btn-primary" type="button" onClick={reset}>
          Try again
        </button>{' '}
        <Link className="btn btn-ghost" href="/">
          Go to events
        </Link>
      </p>
    </div>
  );
}
