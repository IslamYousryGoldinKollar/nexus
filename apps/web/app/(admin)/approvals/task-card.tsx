'use client';

import { useState, useTransition } from 'react';
import { Check, Loader2, Pencil, X } from 'lucide-react';
import type { ProposedTask } from '@nexus/db';
import { StateBadge } from '@/components/ui/state-badge';
import { approveTask, editAndApproveTask, rejectTask } from './actions';

/**
 * One proposed-task card. Three modes:
 *   - view (default): title, description, evidence, action buttons
 *   - edit: editable title + description, save (approves) or cancel
 *   - rejecting: reason textarea + confirm
 *
 * Server actions live in ./actions.ts; this component just dispatches.
 */
export function TaskCard({ task }: { task: ProposedTask }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'rejecting'>('view');
  const [pending, startTransition] = useTransition();

  const isTerminal = task.state !== 'proposed' && task.state !== 'edited';

  if (mode === 'edit') {
    return (
      <form
        action={(fd) =>
          startTransition(async () => {
            await editAndApproveTask(fd);
            setMode('view');
          })
        }
        className="space-y-3 rounded-md border border-border bg-card p-4"
      >
        <input type="hidden" name="taskId" value={task.id} />
        <input
          name="title"
          defaultValue={task.title}
          required
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-medium outline-none focus:border-primary"
        />
        <textarea
          name="description"
          defaultValue={task.description}
          required
          rows={4}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Save & approve
          </button>
          <button
            type="button"
            onClick={() => setMode('view')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (mode === 'rejecting') {
    return (
      <form
        action={(fd) =>
          startTransition(async () => {
            await rejectTask(fd);
            setMode('view');
          })
        }
        className="space-y-3 rounded-md border border-destructive/40 bg-card p-4"
      >
        <input type="hidden" name="taskId" value={task.id} />
        <div className="text-sm">
          <div className="font-medium">{task.title}</div>
          <p className="mt-1 text-xs text-muted-foreground">{task.description}</p>
        </div>
        <textarea
          name="reason"
          rows={2}
          placeholder="Why are you rejecting? (optional)"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:border-destructive"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
            Confirm reject
          </button>
          <button
            type="button"
            onClick={() => setMode('view')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium leading-snug">{task.title}</h3>
        <div className="flex shrink-0 items-center gap-2">
          <StateBadge state={task.priorityGuess} />
          {isTerminal && <StateBadge state={task.state} />}
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{task.description}</p>
      {task.rationale && (
        <p className="rounded-md border-l-2 border-primary/40 bg-muted/40 px-3 py-2 text-xs italic text-muted-foreground">
          {task.rationale}
        </p>
      )}
      {task.evidence?.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground transition hover:text-foreground">
            {task.evidence.length} evidence quote{task.evidence.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 space-y-1.5">
            {task.evidence.map((e, i) => (
              <li
                key={i}
                className="rounded border border-border bg-background px-2.5 py-1.5 text-muted-foreground"
              >
                &ldquo;{e.quote}&rdquo;
              </li>
            ))}
          </ul>
        </details>
      )}

      {!isTerminal && (
        <div className="flex gap-2 pt-1">
          <form
            action={(fd) =>
              startTransition(async () => {
                await approveTask(fd);
              })
            }
            className="inline"
          >
            <input type="hidden" name="taskId" value={task.id} />
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Approve
            </button>
          </form>
          <button
            type="button"
            onClick={() => setMode('edit')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground"
          >
            <Pencil className="size-3.5" /> Edit
          </button>
          <button
            type="button"
            onClick={() => setMode('rejecting')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-destructive/40 hover:text-destructive"
          >
            <X className="size-3.5" /> Reject
          </button>
        </div>
      )}
    </div>
  );
}
