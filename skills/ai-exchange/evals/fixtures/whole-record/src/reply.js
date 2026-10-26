// Drafts a reply to a support ticket.
import { db } from './db.js';
import { llm } from './llm.js';
import { ReplySchema } from './schemas.js';

export async function draftReply(ticketId) {
  const ticket = await db.tickets.get(ticketId);
  const customer = await db.customers.get(ticket.customerId); // includes dob, ssnLast4, address, paymentMethods, notes
  const history = await db.tickets.allFor(ticket.customerId); // every ticket this customer ever filed
  const out = await llm.generate({
    schema: ReplySchema,
    prompt: `Write a polite reply to this ticket.\nTicket: ${JSON.stringify(ticket)}\nCustomer: ${JSON.stringify(customer)}\nHistory: ${JSON.stringify(history)}`,
  });
  const parsed = ReplySchema.safeParse(out);
  if (!parsed.success) throw new Error('invalid reply');
  return parsed.data; // shown to an agent for approval before sending
}
