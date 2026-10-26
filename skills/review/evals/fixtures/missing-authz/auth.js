export function requireOwner(user, note) {
  if (!note || note.ownerId !== user.id) throw Object.assign(new Error('forbidden'), { status: 403 });
}
