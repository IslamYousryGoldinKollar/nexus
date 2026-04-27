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

export interface InjazProjectSummary {
  id: string;
  name: string;
  status: string;
  description: string | null;
  openTaskCount: number;
  /** Most-frequent assignee on the project's open tasks — best
   *  available proxy for "who owns this project" since Injaz's
   *  schema has no explicit project-lead field. Null when the
   *  project has no open tasks or all assignees are unset. */
  leadAssigneeName: string | null;
}

/**
 * All ACTIVE projects for a client + how many open tasks each carries
 * + who's been working on it most. Lets the reasoner answer "for this
 * client, which project should the new task land in" and "who's
 * already running it."
 */
export async function listInjazProjectsForClient(
  clientName: string,
): Promise<InjazProjectSummary[]> {
  const c = client();
  if (!c) return [];
  const rows = await c<
    Array<{
      id: string;
      name: string;
      status: string;
      description: string | null;
      openTaskCount: string;
      leadAssigneeName: string | null;
    }>
  >`
    WITH proj_open AS (
      SELECT p.id, p.name, p.status, p.description,
             t.id AS task_id, u.name AS assignee_name
      FROM "Project" p
      LEFT JOIN "Party" party ON party.id = p."clientPartyId"
      LEFT JOIN "Task" t
        ON t."projectId" = p.id
       AND t.status NOT IN ('Done', 'Cancelled', 'Archived')
      LEFT JOIN "User" u ON u.id = t."assigneeId"
      WHERE party.name = ${clientName} AND p.status = 'ACTIVE'
    ),
    lead_per_proj AS (
      SELECT id,
             assignee_name,
             ROW_NUMBER() OVER (PARTITION BY id ORDER BY COUNT(*) DESC NULLS LAST) AS rk
      FROM proj_open
      WHERE assignee_name IS NOT NULL
      GROUP BY id, assignee_name
    )
    SELECT
      p.id,
      p.name,
      p.status,
      p.description,
      COUNT(po.task_id)::text AS "openTaskCount",
      (SELECT assignee_name FROM lead_per_proj l
        WHERE l.id = p.id AND l.rk = 1) AS "leadAssigneeName"
    FROM proj_open p
    GROUP BY p.id, p.name, p.status, p.description
    ORDER BY COUNT(po.task_id) DESC, p.name ASC
  `.catch(async () => {
    // Window-function CTE may not be allowed on all Prisma-managed
    // Postgres permission setups. Fall back to a two-query approach:
    // load summaries first, then look up the lead per project in a
    // second round-trip. Slower but always works.
    return fallbackProjectsForClient(c, clientName);
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    description: r.description,
    openTaskCount: Number(r.openTaskCount),
    leadAssigneeName: r.leadAssigneeName,
  }));
}

async function fallbackProjectsForClient(
  c: Sql,
  clientName: string,
): Promise<
  Array<{
    id: string;
    name: string;
    status: string;
    description: string | null;
    openTaskCount: string;
    leadAssigneeName: string | null;
  }>
> {
  const summaries = await c<
    Array<{
      id: string;
      name: string;
      status: string;
      description: string | null;
      openTaskCount: string;
    }>
  >`
    SELECT p.id, p.name, p.status, p.description,
           COUNT(t.id) FILTER (
             WHERE t.status NOT IN ('Done', 'Cancelled', 'Archived')
           )::text AS "openTaskCount"
    FROM "Project" p
    LEFT JOIN "Party" party ON party.id = p."clientPartyId"
    LEFT JOIN "Task" t ON t."projectId" = p.id
    WHERE party.name = ${clientName} AND p.status = 'ACTIVE'
    GROUP BY p.id, p.name, p.status, p.description
    ORDER BY COUNT(t.id) DESC, p.name ASC
  `;
  if (summaries.length === 0) return [];
  const ids = summaries.map((s) => s.id);
  const leads = await c<Array<{ projectId: string; name: string; n: string }>>`
    SELECT t."projectId" AS "projectId", u.name, COUNT(*)::text AS n
    FROM "Task" t
    JOIN "User" u ON u.id = t."assigneeId"
    WHERE t."projectId" = ANY(${ids})
      AND t.status NOT IN ('Done', 'Cancelled', 'Archived')
    GROUP BY t."projectId", u.name
    ORDER BY t."projectId", COUNT(*) DESC
  `;
  const leadMap = new Map<string, string>();
  for (const l of leads) {
    if (!leadMap.has(l.projectId)) leadMap.set(l.projectId, l.name);
  }
  return summaries.map((s) => ({ ...s, leadAssigneeName: leadMap.get(s.id) ?? null }));
}

export interface InjazClientFull {
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
}

/**
 * Every CLIENT party plus the contact-person field Injaz stores on
 * the row. Used to build the company-context block the reasoner uses
 * to (a) recognise who's on the other end of an email/voice note and
 * (b) correct names that Whisper got slightly wrong (e.g. "Merna" vs
 * "Mirna"). Cheap query — ~10 rows.
 */
export async function listAllInjazClients(): Promise<InjazClientFull[]> {
  const c = client();
  if (!c) return [];
  const rows = await c<
    Array<{
      name: string;
      contactName: string | null;
      email: string | null;
      phone: string | null;
      notes: string | null;
    }>
  >`
    SELECT name, "contactName", email, phone, notes
    FROM "Party"
    WHERE type = 'CLIENT'
    ORDER BY name
  `;
  return rows;
}

export interface InjazEmployeeFull {
  name: string;
  email: string;
  role: string;
  approvalStatus: string;
}

/**
 * Every Injaz user, with role + approvalStatus. The reasoner uses
 * `role` to suggest the right assignee (e.g. design tasks → designers)
 * and uses `approvalStatus` to filter out stale duplicates that show
 * up in the auth table but aren't really active.
 */
export async function listAllInjazEmployees(): Promise<InjazEmployeeFull[]> {
  const c = client();
  if (!c) return [];
  const rows = await c<
    Array<{ name: string; email: string; role: string; approvalStatus: string }>
  >`
    SELECT name, email, role, "approvalStatus"
    FROM "User"
    ORDER BY name
  `;
  return rows;
}

export interface InjazAssigneeWorkload {
  name: string;
  email: string;
  openTasks: number;
}

/**
 * Open task count per Injaz user — used by the reasoner to suggest a
 * less-loaded assignee when nobody is implied by the conversation. Only
 * counts non-terminal task statuses.
 */
export async function listInjazAssigneeWorkload(): Promise<InjazAssigneeWorkload[]> {
  const c = client();
  if (!c) return [];
  const rows = await c<Array<{ name: string; email: string; openTasks: string }>>`
    SELECT
      u.name,
      u.email,
      COUNT(t.id)::text AS "openTasks"
    FROM "User" u
    LEFT JOIN "Task" t
      ON t."assigneeId" = u.id
      AND t.status NOT IN ('Done', 'Cancelled', 'Archived')
    GROUP BY u.id, u.name, u.email
    ORDER BY u.name
  `;
  return rows.map((r) => ({
    name: r.name,
    email: r.email,
    openTasks: Number(r.openTasks),
  }));
}
