import { ChatSession } from '../models/chatSession.model.js';
import { logger } from '../utils/logger.js';

/**
 * Session Controller
 * Handles session CRUD operations
 */
export class SessionController {
  
  /**
   * Create new session
   * POST /api/sessions
   * Body: { title: string }
   */
  static async create(req, res, next) {
    try {
      const { title } = req.body;
      const userId = req.user?.id || null; // From auth middleware

      if (!title || title.trim().length === 0) {
        return res.status(400).json({
          error: 'Title is required',
        });
      }

      const session = await ChatSession.create({
        title: title.trim(),
        user_id: userId,
      });

      logger.info('Session created via API', { 
        session_id: session.id, 
        user_id: userId 
      });

      res.status(201).json({
        session: {
          id: session.id,
          title: session.title,
          created_at: session.created_at,
          updated_at: session.updated_at,
        },
      });
    } catch (error) {
      logger.error('Session creation failed:', error);
      next(error);
    }
  }

  /**
   * Get session with all queries
   * GET /api/sessions/:sessionId
   */
  static async getById(req, res, next) {
    try {
      const { sessionId } = req.params;
      const userId = req.user?.id || null;

      const { session, queries } = await ChatSession.getById(sessionId, userId);

      res.json({
        session: {
          id: session.id,
          title: session.title,
          created_at: session.created_at,
          updated_at: session.updated_at,
        },
        queries: queries.map(q => ({
          id: q.id,
          question: q.question,
          response_text: q.response_text,
          generated_sql: q.generated_sql,
          visualization_type: q.visualization_type,
          result_data: q.result_data ? JSON.parse(q.result_data) : null, 
          chart_config: q.chart_config ? JSON.parse(q.chart_config) : null, 
          status: q.status,
          created_at: q.created_at,
        })),
      });
    } catch (error) {
      if (error.message === 'Session not found') {
        return res.status(404).json({ error: 'Session not found' });
      }
      logger.error('Failed to get session:', error);
      next(error);
    }
  }

  /**
   * List all sessions
   * GET /api/sessions
   * Query params: ?limit=50
   */
  static async list(req, res, next) {
    try {

      logger.info('Listing sessions', { user_id: req.user?.id || null });
      const userId = req.user?.id || null;
      const limit = parseInt(req.query.limit) || 50;

      const sessions = await ChatSession.list(userId, limit);

      res.json({
        sessions: sessions.map(s => ({
          id: s.id,
          title: s.title,
          created_at: s.created_at,
          updated_at: s.updated_at,
          query_count: s.query_count,
          last_query_at: s.last_query_at,
        })),
      });
    } catch (error) {
      logger.error('Failed to list sessions:', error);
      next(error);
    }
  }

  /**
   * Update session title
   * PATCH /api/sessions/:sessionId
   * Body: { title: string }
   */
  static async updateTitle(req, res, next) {
    try {
      const { sessionId } = req.params;
      const { title } = req.body;
      const userId = req.user?.id || null;

      if (!title || title.trim().length === 0) {
        return res.status(400).json({ error: 'Title is required' });
      }

      const session = await ChatSession.updateTitle(
        sessionId, 
        title.trim(), 
        userId
      );

      res.json({
        session: {
          id: session.id,
          title: session.title,
          updated_at: session.updated_at,
        },
      });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Session not found' });
      }
      logger.error('Failed to update session:', error);
      next(error);
    }
  }

  /**
   * Delete session (soft delete)
   * DELETE /api/sessions/:sessionId
   */
  static async delete(req, res, next) {
    try {
      const { sessionId } = req.params;
      const userId = req.user?.id || null;

      await ChatSession.delete(sessionId, userId);

      res.json({ success: true });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Session not found' });
      }
      logger.error('Failed to delete session:', error);
      next(error);
    }
  }
}