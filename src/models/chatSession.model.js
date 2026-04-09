// src/models/chatSession.model.js
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';

export class ChatSession {
  
  static async create({ title, user_id = null }) {
    try {
      const [session] = await db('chat_sessions')
        .insert({
          title: title.slice(0, 255),
          user_id,
          // PostgreSQL auto-generates UUID and timestamps
        })
        .returning('*'); // PostgreSQL supports RETURNING

      logger.info('Session created', { session_id: session.id, title });
      return session;
    } catch (error) {
      logger.error('Failed to create session:', error);
      throw error;
    }
  }

  static async getById(sessionId, userId = null) {
    try {
      const sessionQuery = db('chat_sessions')
        .where('id', sessionId)
        .whereNull('deleted_at')
        .first();

      if (userId) {
        sessionQuery.where('user_id', userId);
      }

      const session = await sessionQuery;

      if (!session) {
        throw new Error('Session not found');
      }

      const queries = await db('chat_queries')
        .where('session_id', sessionId)
        .whereNull('deleted_at')
        .orderBy('created_date', 'asc')
        .select(
          'id',
          'question',
          'generated_sql',
          'response_text',
          'visualization_type',
          'result_data',
          'chart_config',
          'status',
          'created_date'
        );

      return { session, queries };
    } catch (error) {
      logger.error('Failed to get session:', error);
      throw error;
    }
  }

  static async list(userId = null, limit = 50) {
    try {
      const query = db('v_chat_sessions')
        .orderBy('updated_at', 'desc')
        .limit(limit);

      if (userId) {
        query.where('user_id', userId);
      }

      const sessions = await query;

      logger.info('Sessions listed', { 
        user_id: userId, 
        count: sessions.length 
      });

      return sessions;
    } catch (error) {
      logger.error('Failed to list sessions:', error);
      throw error;
    }
  }

  static async updateTitle(sessionId, title, userId = null) {
    try {
      const updateQuery = db('chat_sessions')
        .where('id', sessionId)
        .whereNull('deleted_at');

      if (userId) {
        updateQuery.where('user_id', userId);
      }

      const [session] = await updateQuery
        .update({
          title: title.slice(0, 255),
          updated_at: db.fn.now(),
        })
        .returning('*'); // PostgreSQL

      if (!session) {
        throw new Error('Session not found or unauthorized');
      }

      logger.info('Session title updated', { session_id: sessionId, title });
      return session;
    } catch (error) {
      logger.error('Failed to update session title:', error);
      throw error;
    }
  }

  static async delete(sessionId, userId = null) {
    try {
      const deleteQuery = db('chat_sessions')
        .where('id', sessionId)
        .whereNull('deleted_at');

      if (userId) {
        deleteQuery.where('user_id', userId);
      }

      const result = await deleteQuery.update({
        deleted_at: db.fn.now(),
      });

      if (result === 0) {
        throw new Error('Session not found or unauthorized');
      }

      await db('chat_queries')
        .where('session_id', sessionId)
        .whereNull('deleted_at')
        .update({ deleted_at: db.fn.now() });

      logger.info('Session deleted', { session_id: sessionId });
      return true;
    } catch (error) {
      logger.error('Failed to delete session:', error);
      throw error;
    }
  }

  static async touch(sessionId) {
    try {
      await db('chat_sessions')
        .where('id', sessionId)
        .update({ updated_at: db.fn.now() });
    } catch (error) {
      logger.warn('Failed to touch session:', error);
    }
  }
}