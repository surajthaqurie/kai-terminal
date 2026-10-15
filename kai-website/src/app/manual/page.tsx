import { redirect } from 'next/navigation';

// Legacy URL — canonical lives at /commands.
export default function Page() {
  redirect('/commands');
}
