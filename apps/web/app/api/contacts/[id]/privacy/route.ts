import { NextResponse } from 'next/server';
import { getDb, contacts, eq } from '@nexus/db';
import { z } from 'zod';

const schema = z.object({
  allowTranscription: z.boolean().optional(),
  allowAction: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const parsed = schema.parse(body);

    const db = getDb();
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, id))
      .limit(1);

    if (!contact) {
      return NextResponse.json({ error: 'contact_not_found' }, { status: 404 });
    }

    const updateData: Record<string, boolean> = {};
    if (parsed.allowTranscription !== undefined) {
      updateData.allowTranscription = parsed.allowTranscription;
    }
    if (parsed.allowAction !== undefined) {
      updateData.allowAction = parsed.allowAction;
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'no_fields_to_update' }, { status: 400 });
    }

    await db
      .update(contacts)
      .set(updateData)
      .where(eq(contacts.id, id));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Failed to update contact privacy:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
