import Link from 'next/link';

export function NoAccess() {
  return (
    <div className="card form-card">
      <h1>Organizers only</h1>
      <p>Door staff accounts can only use the check-in screen.</p>
      <p>
        <Link className="btn btn-primary" href="/staff/checkin">
          Go to check-in
        </Link>
      </p>
    </div>
  );
}
