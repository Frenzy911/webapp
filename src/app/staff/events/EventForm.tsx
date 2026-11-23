'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Field } from '@/components/Field';
import { SubmitButton } from '@/components/ConfirmForm';
import type { EventFormValues } from '@/lib/validation';
import { saveEventAction, type EventFormState } from '../actions';

export function EventForm({ eventId, values, minCapacity }: { eventId: number | null; values: EventFormValues; minCapacity: number | null }) {
  const [state, formAction] = useActionState(saveEventAction.bind(null, eventId), { values, errors: {} } satisfies EventFormState);
  const v = state.values;
  const errorCount = Object.keys(state.errors).length;
  const back = eventId ? `/staff/events/${eventId}/attendees` : '/staff/events';

  return (
    <>
      {errorCount > 0 && (
        <div className="notice notice-error" role="alert">
          Please fix the {errorCount === 1 ? 'field' : `${errorCount} fields`} marked below. Nothing was saved.
        </div>
      )}
      <form action={formAction} className="stack" noValidate>
        <Field name="title" label="Title" value={v.title} errors={state.errors} input={{ maxLength: 120 }} />
        <Field name="description" label="Description" type="textarea" value={v.description} errors={state.errors} />
        <Field name="venue" label="Venue" value={v.venue} errors={state.errors} input={{ maxLength: 160 }} />
        <div className="grid-3">
          <Field name="date" label="Date" type="date" value={v.date} errors={state.errors} />
          <Field name="start_time" label="Start time" type="time" value={v.startTime} errors={state.errors} />
          <Field name="end_time" label="End time" type="time" value={v.endTime} errors={state.errors} />
        </div>
        <p className="hint">Cebu time (UTC+8). Shown to attendees in 12-hour format, e.g. 6:00 PM.</p>
        <div className="grid-2">
          <Field
            name="capacity"
            label="Capacity"
            type="number"
            value={v.capacity}
            errors={state.errors}
            hint={minCapacity !== null ? `At least ${Math.max(minCapacity, 1)} (people already registered).` : 'At least 1.'}
            input={{ min: 1, inputMode: 'numeric' }}
          />
          <Field
            name="status"
            label="Status"
            type="select"
            value={v.status}
            errors={state.errors}
            options={[
              ['draft', 'Draft (hidden)'],
              ['published', 'Published (open)'],
              ['closed', 'Closed (no new registrations)'],
            ]}
          />
        </div>
        <div className="form-actions">
          <SubmitButton>{eventId ? 'Save changes' : 'Create event'}</SubmitButton>
          <Link className="btn btn-ghost" href={back}>
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
