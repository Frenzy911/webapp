'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Field } from '@/components/Field';
import { SubmitButton } from '@/components/ConfirmForm';
import { registerAction, type RegisterState } from './actions';

export function RegisterForm({ eventId, full }: { eventId: number; full: boolean }) {
  const initial: RegisterState = { values: { full_name: '', email: '', mobile: '' }, errors: {}, formError: null, duplicate: false, waitlist: full };
  const [state, formAction] = useActionState(registerAction.bind(null, eventId), initial);
  const errorCount = Object.keys(state.errors).length;

  return (
    <>
      {state.waitlist && (
        <div className="notice notice-warning">
          <strong>This event is full.</strong> Join the waitlist and you&apos;ll get a place in line. You are <strong>not confirmed</strong> until a spot opens and
          staff move you up. We&apos;ll email you when that happens.
        </div>
      )}

      {state.formError ? (
        <div className="notice notice-error" role="alert">
          {state.formError}
          {state.duplicate && (
            <>
              {' '}
              <Link href="/tickets/find">Find my ticket →</Link>
            </>
          )}
        </div>
      ) : errorCount > 0 ? (
        <div className="notice notice-error" role="alert">
          Please fix the {errorCount === 1 ? 'field' : `${errorCount} fields`} marked below.
        </div>
      ) : null}

      <form action={formAction} noValidate className="stack">
        {state.waitlist && <input type="hidden" name="waitlist" value="1" />}
        <Field name="full_name" label="Full name" value={state.values.full_name} errors={state.errors} input={{ autoComplete: 'name', maxLength: 100 }} />
        <Field
          name="email"
          label="Email"
          type="email"
          value={state.values.email}
          errors={state.errors}
          hint="Your ticket is sent here. You also need it to find your ticket later."
          input={{ autoComplete: 'email', inputMode: 'email' }}
        />
        <Field
          name="mobile"
          label="Mobile number"
          type="tel"
          value={state.values.mobile}
          errors={state.errors}
          hint="11 digits, starts with 09"
          input={{ autoComplete: 'tel-national', inputMode: 'numeric', placeholder: '09171234567', maxLength: 16 }}
        />
        <SubmitButton className="btn btn-primary btn-big">{state.waitlist ? 'Join waitlist' : 'Register'}</SubmitButton>
      </form>
    </>
  );
}
