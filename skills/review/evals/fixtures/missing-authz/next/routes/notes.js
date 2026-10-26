import { requireOwner } from '../auth.js';

export function routes(app, db) {
  app.get('/notes/:id', async (req, res) => {
    const note = await db.notes.find(req.params.id);
    requireOwner(req.user, note);
    res.json(note);
  });

  app.delete('/notes/:id', async (req, res) => {
    await db.notes.delete(req.params.id);
    res.status(204).end();
  });
}
