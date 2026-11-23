import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/NoAccess';
import { requireStaff } from '@/lib/auth';
import { unexpected } from '@/lib/errors';
import { smtpConfigured } from '@/lib/mailer';
import { db } from '@/lib/supabase/admin';
import { formatDateTime } from '@/lib/time';

type Mail = { id: number; kind: string; to_address: string; subject: string; status: string; error: string | null; created_at: string };
const COLUMNS = 'id, kind, to_address, subject, status, error, created_at';

/** Emails page: the last 100 emails, and a preview of the selected one in a sandboxed frame. */
export async function Outbox({ selectedId }: { selectedId: number | null }) {
  const staff = await requireStaff();
  if (staff.role !== 'organizer') return <NoAccess />;

  const { data, error } = await db().from('email_outbox').select(COLUMNS).order('id', { ascending: false }).limit(100);
  if (error) unexpected(error, 'outbox');
  const rows = (data || []) as Mail[];
  let selected: Mail | null = null;
  if (selectedId) {
    const res = await db().from('email_outbox').select(COLUMNS).eq('id', selectedId).maybeSingle<Mail>();
    if (res.error) unexpected(res.error, 'outbox email');
    if (!res.data) notFound();
    selected = res.data;
  }

  return (
    <>
      <section className="page-head">
        <h1>Emails</h1>
        {smtpConfigured() ? (
          <p className="lead">Ticket emails are sent through your SMTP service. A copy of each one is kept here.</p>
        ) : (
          <div className="notice notice-info">
            <strong>SMTP is not set up</strong>, so emails are saved here instead of being sent. Add your SMTP settings (Resend, Brevo, Mailtrap…) to the
            environment variables (see README) to deliver them.
          </div>
        )}
      </section>

      <div className={`outbox${selected ? ' has-selected' : ''}`}>
        <ul className="outbox-list card">
          {rows.length === 0 && <li className="muted">No emails yet.</li>}
          {rows.map((m) => (
            <li key={m.id}>
              <Link href={`/staff/outbox/${m.id}`} aria-current={selected?.id === m.id ? 'true' : undefined}>
                <span className="outbox-subject">{m.subject}</span>
                <span className="meta">
                  {m.to_address} · {formatDateTime(m.created_at)}
                </span>
                <span className={`badge badge-${m.status === 'sent' ? 'success' : m.status === 'failed' ? 'danger' : 'muted'}`}>
                  {m.status === 'saved' ? 'Saved (not sent)' : m.status === 'sent' ? 'Sent' : 'Failed'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {selected && (
          <section className="outbox-preview card">
            <p>
              <strong>{selected.subject}</strong>
              <br />
              <span className="meta">
                To {selected.to_address} · {formatDateTime(selected.created_at)}
              </span>
            </p>
            {selected.error && <div className="notice notice-error">Send failed: {selected.error}</div>}
            <iframe src={`/staff/outbox/${selected.id}/raw`} title="Email preview" sandbox="allow-same-origin" className="outbox-frame" />
          </section>
        )}
      </div>
    </>
  );
}
