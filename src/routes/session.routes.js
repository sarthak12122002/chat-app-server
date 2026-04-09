import express from 'express';
import { SessionController } from '../controllers/session.controller.js';
import { body, param, query } from 'express-validator';

const router = express.Router();

/**
 * Session Routes
 * All routes use optional auth - work with or without authentication
 */

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sessions - Create new session
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/',
  [
    body('title')
      .isString()
      .trim()
      .isLength({ min: 1, max: 255 })
      .withMessage('Title must be between 1 and 255 characters'),
  ],
  SessionController.create
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sessions - List all sessions
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/',
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
  ],
  SessionController.list
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sessions/:sessionId - Get session with queries
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:sessionId',
  [
    param('sessionId')
      .isUUID()
      .withMessage('Invalid session ID'),
  ],
  SessionController.getById
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/sessions/:sessionId - Update session title
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/:sessionId',
  [
    param('sessionId')
      .isUUID()
      .withMessage('Invalid session ID'),
    body('title')
      .isString()
      .trim()
      .isLength({ min: 1, max: 255 })
      .withMessage('Title must be between 1 and 255 characters'),
  ],
  SessionController.updateTitle
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/sessions/:sessionId - Delete session
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  '/:sessionId',
  [
    param('sessionId')
      .isUUID()
      .withMessage('Invalid session ID'),
  ],
  SessionController.delete
);

export default router;