// Dispatches webhook events to a handler module named after the event type.
export async function dispatch(event) {
  const mod = await import(`./handlers/${event.type}.js`);
  return mod.handle(event);
}
