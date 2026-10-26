import { complete } from './llm.js';

// The result is written to the invoices table.
export async function extractUsage(log) {
  const text = await complete(`Return JSON {units:number} for this log:\n${log}`);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
