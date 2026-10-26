export function routes(app, db) {
  app.get('/invoices/:id', async (req, res) => res.json(await db.invoices.find(req.params.id)));
  app.delete('/invoices/:id', async (req, res) => { await db.invoices.delete(req.params.id); res.status(204).end(); });
}
