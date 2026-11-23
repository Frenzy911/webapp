import { Suspense } from 'react';
import { ConfirmForm } from '@/components/ConfirmForm';
import { Loading } from '@/components/Icon';
import { NoAccess } from '@/components/NoAccess';
import { requireStaff } from '@/lib/auth';
import { listStaff } from '@/lib/staff';
import { setStaffActiveAction } from '../actions';
import { StaffForm } from './StaffForm';

export const metadata = { title: 'Staff accounts' };

export default function UsersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Users />
    </Suspense>
  );
}

async function Users() {
  const me = await requireStaff();
  if (me.role !== 'organizer') return <NoAccess />;
  const users = await listStaff();

  return (
    <>
      <section className="page-head">
        <h1>Staff accounts</h1>
        <p className="lead">
          <strong>Organizers</strong> manage events, attendees and staff. <strong>Door staff</strong> can only use the check-in screen.
        </p>
      </section>

      <div className="table-wrap card">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.name}</strong>
                  {u.id === me.id ? ' (you)' : ''}
                </td>
                <td>{u.email}</td>
                <td>{u.role === 'organizer' ? 'Organizer' : 'Door staff'}</td>
                <td>
                  <span className={`badge badge-${u.active ? 'success' : 'muted'}`}>{u.active ? 'Active' : 'Deactivated'}</span>
                </td>
                <td className="actions-cell">
                  {u.id !== me.id && (
                    <ConfirmForm
                      action={setStaffActiveAction.bind(null, u.id, !u.active)}
                      confirm={u.active ? `Deactivate ${u.name}? They are signed out and can't sign in again until reactivated.` : undefined}
                      className="inline"
                      buttonClassName="btn btn-small btn-ghost"
                      label={u.active ? 'Deactivate' : 'Reactivate'}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card form-card wide">
        <h2>Add a staff account</h2>
        <StaffForm />
      </div>
    </>
  );
}
