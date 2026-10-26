import { z } from 'zod';
export const Order = z.object({ sku: z.string(), quantity: z.number().int().positive() }).strict();
