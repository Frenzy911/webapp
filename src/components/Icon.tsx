/** Uses the SVG symbols defined once in the root layout. */
export function Icon({ name }: { name: 'calendar' | 'pin' | 'ticket' | 'arrow' }) {
  return (
    <svg className="icon" aria-hidden="true">
      <use href={`#icon-${name}`} />
    </svg>
  );
}

/** Placeholder shown while a page's data streams in. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="card empty-state" aria-busy="true">
      <p>{label}</p>
    </div>
  );
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone = status === 'published' ? 'success' : status === 'draft' ? 'muted' : 'warning';
  return <span className={`badge badge-${tone}`}>{label}</span>;
}
