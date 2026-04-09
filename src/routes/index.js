import express from 'express';
import authRoutes from './auth.routes.js';
import chatRoutes from './chat.routes.js';
import queryRoutes from './query.routes.js';
import analyticsRoutes from './analytics.routes.js';
import schemaRoutes from './schema.routes.js';
import sessionRoutes from './session.routes.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/chat', chatRoutes);
router.use('/queries', queryRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/schema', schemaRoutes);
router.use('/sessions', sessionRoutes);

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;