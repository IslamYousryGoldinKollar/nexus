import Link from 'next/link';
import {
  CircleDollarSign,
  Contact,
  Inbox,
  Link2,
  LogOut,
  MessagesSquare,
  Settings,
  SquareCheckBig,
} from 'lucide-react';
import { readSession } from '@/lib/auth/session';
import { redirect } from 'next/navigation';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', Icon: Inbox },
  { href: '/approvals', label: 'Approvals', Icon: SquareCheckBig },
  { href: '/sessions', label: 'Sessions', Icon: MessagesSquare },
  { href: '/contacts', label: 'Contacts', Icon: Contact },
  { href: '/pending-identifiers', label: 'Pending IDs', Icon: Link2 },
  { href: '/costs', label: 'Costs', Icon: CircleDollarSign },
  { href: '/settings', label: 'Settings', Icon: Settings },
] as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession();
  if (!session) redirect('/login');

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-64 flex-col border-r border-border bg-card px-4 py-6">
        <div className="mb-8 flex items-center gap-3 px-2">
          <span className="inline-block size-2 rounded-full bg-primary" />
          <span className="text-sm font-semibold tracking-tight">Nexus</span>
          <span className="text-xs text-muted-foreground">admin</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {navItems.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              className="group flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <Icon className="size-4" />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-2">
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Signed in</div>
            <div className="truncate text-xs font-medium" title={session.email}>
              {session.email}
            </div>
          </div>
          <form action="/api/auth/sign-out" method="post">
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition hover:border-destructive/40 hover:text-destructive"
            >
              <LogOut className="size-3.5" />
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 px-8 py-8">{children}</main>
    </div>
  );
}
