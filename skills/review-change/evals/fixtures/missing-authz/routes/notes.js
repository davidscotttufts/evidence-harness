import { requireOwner } from '../auth.js';

export function routes(app, db) {
  app.get('/notes/:id', async (req, res) => {
    const note = await db.notes.find(req.params.id);
    requireOwner(req.user, note);
    res.json(note);
  });
}
