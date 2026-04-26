import postgres, { type Sql } from 'postgres';

/**
 * Direct read-only access to the Injaz Postgres (Prisma-managed).
 *
 * Used to fetch existing tasks before reasoning so the AI can decide
 * "this is an update to task X" vs "new task" instead of always
 * producing duplicates. Writes still go through MCP (`create_task` /
 * `update_task`) so Injaz's validation, audit log, and triggers stay
 * authoritative.
 *
 * Connection lazy-init'd, single client reused across requests inside
 * the same Vercel lambda. We pin `max: 4` because Prisma's hosted
 * Postgres has tight per-connection limits on the free tier.
 *
 * Set INJAZ_DATABASE_URL to the *direct* postgres URL, not the
 * Accelerate URL (which speaks Prisma's wire protocol, not raw SQL).
 */

let _client: Sql | null = null;
function client(): Sql | null {
  if (_client) return _client;
  const url = process.env.INJAZ_DATABASE_URL?.trim();
  if (!url) return null;
  _client = postgres(url, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: 'require',
    prepare: false, // Prisma's pgbouncer compat
  });
  return _client;
}

export interface InjazExistingTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  dueDate: Date | null;
  startDate: Date | null;
  assigneeName: string | null;
  projectName: string | null;
  clientName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Fetch open tasks attached to a given Injaz client (matched by name)
 * and/or project. Either filter may be undefined; passing both narrows
 * to that project. We exclude Done/Cancelled/Archived so the AI only
 * sees actionable work.
 *
 * Returns [] when INJAZ_DATABASE_URL isn't set — callers fall back to
 * "always create new" behavior.
 */
export async function listOpenInjazTasksForClient(args: {
  clientName?: string | null;
  projectName?: string | null;
  limit?: number;
}): Promise<InjazExistingTask[]> {
  const c = client();
  if (!c) return [];
  const limit = args.limit ?? 30;

  // We construct WHERE dynamically because tagged template literals in
  // postgres.js make AND/OR composition awkward. The two text params
  // (clientName, projectName) are still bound — no string interpolation.
  const whereParts: string[] = [`t.status NOT IN ('Done', 'Cancelled', 'Archived')`];
  if (args.clientName) whereParts.push(`party.name = $1`);
  if (args.projectName) {
    whereParts.push(args.clientName ? `p.name = $2` : `p.name = $1`);
  }
  const whereSql = whereParts.join(' AND ');
  const params: string[] = [];
  if (args.clientName) params.push(args.clientName);
  if (args.projectName) params.push(args.projectName);

  const rows = await c.unsafe<
    Array<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: string | null;
      dueDate: Date | null;
      startDate: Date | null;
      assigneeName: string | null;
      projectName: string | null;
      clientName: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >(
    `
    SELECT
      t.id,
      t.title,
      t.description,
      t.status,
      t.priority,
      t."dueDate"          AS "dueDate",
      t."startDate"        AS "startDate",
      u.name               AS "assigneeName",
      p.name               AS "projectName",
      party.name           AS "clientName",
      t."createdAt"        AS "createdAt",
      t."updatedAt"        AS "updatedAt"
    FROM "Task" t
    LEFT JOIN "Project" p ON p.id = t."projectId"
    LEFT JOIN "Party" party ON party.id = p."clientPartyId"
    LEFT JOIN "User" u ON u.id = t."assigneeId"
    WHERE ${whereSql}
    ORDER BY t."updatedAt" DESC
    LIMIT ${limit}
    `,
    params,
  );

  return rows;
}
