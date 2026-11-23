'use client';

import { useActionState } from 'react';
import { Field } from '@/components/Field';
import { SubmitButton } from '@/components/ConfirmForm';
import { findTicketAction, type FindState } from '../actions';

export function FindTicketForm({ code }: { code: string }) {
  const [state, formAction] = useActionState(findTicketAction, { values: { code, contact: '' }, notFound: false, error: null } satisfies FindState);
  return (
    <>
      {state.notFound && (
        <div className="notice notice-error" role="alert">
          <strong>Ticket not found.</strong> Check the ticket code and your email or mobile number, then try again.
        </div>
      )}
      {state.error && (
        <div className="notice notice-error" role="alert">
          {state.error}
        </div>
      )}
      <form action={formAction} className="stack" noValidate>
        <Field
          name="code"
          label="Ticket code"
          value={state.values.code}
          input={{ placeholder: 'CDM-7K3P9QXM', autoComplete: 'off', maxLength: 32, autoCapitalize: 'characters', spellCheck: false, required: true }}
        />
        <Field name="contact" label="Email or mobile number" value={state.values.contact} input={{ autoComplete: 'email', maxLength: 254, spellCheck: false, required: true }} />
        <SubmitButton className="btn btn-primary btn-big">Find ticket</SubmitButton>
      </form>
    </>
  );
}
