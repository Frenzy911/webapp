'use client';

import { useActionState } from 'react';
import { Field } from '@/components/Field';
import { SubmitButton } from '@/components/ConfirmForm';
import { signInAction } from '../actions';

export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useActionState(signInAction, { email: '', error: null });
  return (
    <>
      {state.error && (
        <div className="notice notice-error" role="alert">
          {state.error}
        </div>
      )}
      <form action={formAction} className="stack">
        <input type="hidden" name="next" value={next} />
        <Field name="email" label="Email" type="email" value={state.email} input={{ autoComplete: 'username', autoCapitalize: 'none', spellCheck: false, required: true }} />
        <Field name="password" label="Password" type="password" input={{ autoComplete: 'current-password', required: true }} />
        <SubmitButton className="btn btn-primary btn-big">Sign in</SubmitButton>
      </form>
    </>
  );
}
