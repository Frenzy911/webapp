'use client';

import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * A form that posts to a Server Action. If `confirm` is set it asks first. While the action runs the
 * button is disabled, so a double tap on a slow connection can't submit twice.
 */
export function ConfirmForm({
  action,
  confirm,
  className,
  buttonClassName = 'btn',
  label,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  confirm?: string;
  className?: string;
  buttonClassName?: string;
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <form
      action={action}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <SubmitButton className={buttonClassName}>{label}</SubmitButton>
    </form>
  );
}

export function SubmitButton({ className = 'btn btn-primary', children, disabled }: { className?: string; children: ReactNode; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={pending || disabled} aria-disabled={pending || disabled}>
      {children}
    </button>
  );
}
