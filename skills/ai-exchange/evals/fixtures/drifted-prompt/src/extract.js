import { Order } from './order.schema.js';
import { readFileSync } from 'node:fs';
const prompt = readFileSync('prompts/order.md', 'utf8');
export async function extract(complete, text) {
  return Order.parse(JSON.parse(await complete(prompt + text)));
}
