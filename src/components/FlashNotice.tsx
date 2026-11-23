'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * The notice lives in the root layout, which stays mounted while you move between pages.
 * So: clear the cookie as soon as the message is on screen (it shows once), and hide the
 * message when you navigate away from the page it was meant for.
 */
export function FlashNotice({ type, message }: { type: 'success' | 'error'; message: string }) {
  const path = usePathname();
  const [shownOn] = useState(path);

  useEffect(() => {
    document.cookie = 'flash=; Max-Age=0; Path=/; SameSite=Lax';
  }, []);

  if (path !== shownOn) return null;
  const error = type === 'error';
  return (
    <div className={`notice ${error ? 'notice-error' : 'notice-success'}`} role={error ? 'alert' : 'status'}>
      <strong>{error ? 'Not done:' : 'Done:'}</strong> {message}
    </div>
  );
}
