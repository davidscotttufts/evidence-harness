import { randomUUID } from 'node:crypto';
// Runs on every first visit of a workspace (and again after each deploy).
export async function ensureStarterBoard(db, workspaceId) {
  await db.boards.insert({ id: randomUUID(), workspaceId, name: 'Getting started' });
}
