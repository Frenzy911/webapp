import { readFlash } from '@/lib/flash';
import { FlashNotice } from './FlashNotice';

/** Shows the one-time message a Server Action left before redirecting here. */
export async function FlashMessage() {
  const flash = await readFlash();
  if (!flash) return null;
  return <FlashNotice key={flash.id} type={flash.type} message={flash.message} />;
}
