import express from 'express';
import { ChatController } from '../controllers/chat.controller.js';
import { validate } from '../middleware/validate.middleware.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { chatRateLimiter } from '../middleware/rateLimit.middleware.js';
import { chatQuerySchema } from '../utils/validators.js';
import { validateSchemaForModel } from '../middleware/schema.middleware.js';

const router = express.Router();

// Apply auth middleware (optional auth - user can be null)
router.use(authMiddleware(false));

router.post(
  '/query',
  chatRateLimiter,
  validate(chatQuerySchema),
  validateSchemaForModel,
  ChatController.processQuery
);

router.post(
  '/query/stream',
  chatRateLimiter,
  validate(chatQuerySchema),
  validateSchemaForModel,
  ChatController.processQueryStream
);

router.get('/suggestions', ChatController.getSuggestedQueries);

export default router;