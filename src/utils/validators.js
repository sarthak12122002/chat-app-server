import { z } from 'zod';

const chatHistoryMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string()
});

export const chatQuerySchema = z.object({
  question: z.string().min(3).max(1000),
  session_id: z.string().uuid().optional(),
  history: z.array(chatHistoryMessageSchema).optional().default([])
});

export const updateQuerySchema = z.object({
  is_saved: z.boolean().optional(),
  response_text: z.string().optional(),
  status: z.enum(['pending', 'completed', 'error', 'rejected']).optional()
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(2).max(255).optional()
});

export const queryListSchema = z.object({
  sort: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  is_saved: z.enum(['true', 'false']).optional()
});
