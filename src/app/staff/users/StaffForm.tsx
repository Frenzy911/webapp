'use client';

import { useActionState } from 'react';
import { Field } from '@/components/Field';
import { SubmitButton } from '@/components/ConfirmForm';
import { createStaffAction, type StaffFormState } from '../actions';

export function StaffForm() {
  const [state, formAction] = useActionState(createStaffAction, { values: { name: '', email: '', role: 'door' }, errors: {}, created: null } satisfies StaffFormState);
  return (
    <form action={formAction} className="stack" noValidate>
      <div className="grid-2">
        <Field name="name" label="Name" value={state.values.name} errors={state.errors} input={{ maxLength: 100 }} />
        <Field name="email" label="Email" type="email" value={state.values.email} errors={state.errors} input={{ autoCapitalize: 'none', spellCheck: false }} />
      </div>
      <div className="grid-2">
        <Field
          name="password"
          label="Password"
          type="password"
          errors={state.errors}
          hint="At least 8 characters. Share it with them privately; Supabase Auth stores only a hash."
          input={{ autoComplete: 'new-password' }}
        />
        <Field
          name="role"
          label="Role"
          type="select"
          value={state.values.role}
          errors={state.errors}
          options={[
            ['door', 'Door staff (check-in only)'],
            ['organizer', 'Organizer'],
          ]}
        />
      </div>
      <div className="form-actions">
        <SubmitButton>Create account</SubmitButton>
      </div>
    </form>
  );
}
