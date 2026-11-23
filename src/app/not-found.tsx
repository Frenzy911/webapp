import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="card form-card">
      <h1>Page not found</h1>
      <p>That page does not exist or is no longer available.</p>
      <p>
        <Link className="btn btn-ghost" href="/">
          Go to events
        </Link>
      </p>
    </div>
  );
}
