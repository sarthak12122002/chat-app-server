import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';

export class QueryService {
  static async create(data) {
    try {
      const [query] = await db('chat_queries')
        .insert({
          ...data,
          created_date: new Date(),
          updated_at: new Date()
        })
        .returning('*');
      
      return query;
    } catch (error) {
      logger.error('Error creating query:', error);
      throw error;
    }
  }

  static async list(options = {}) {
    try {
      const {
        sort = '-created_date',
        limit = 100,
        is_saved,
        user_id
      } = options;

      let query = db('chat_queries');

      if (is_saved !== undefined) {
        query = query.where({ is_saved: is_saved === 'true' });
      }

      if (user_id !== undefined) {
        query = query.where({ user_id });
      }

      // Handle sorting
      const sortDesc = sort.startsWith('-');
      const sortField = sortDesc ? sort.substring(1) : sort;
      query = query.orderBy(sortField, sortDesc ? 'desc' : 'asc');

      query = query.limit(Math.min(limit, 200));

      const results = await query.select('*');
      return results;
    } catch (error) {
      logger.error('Error listing queries:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const query = await db('chat_queries')
        .where({ id })
        .first();
      
      return query;
    } catch (error) {
      logger.error('Error finding query:', error);
      throw error;
    }
  }

  static async update(id, data) {
    try {
      const [query] = await db('chat_queries')
        .where({ id })
        .update({
          ...data,
          updated_at: new Date()
        })
        .returning('*');
      
      return query;
    } catch (error) {
      logger.error('Error updating query:', error);
      throw error;
    }
  }

  static async delete(id) {
    try {
      await db('chat_queries')
        .where({ id })
        .delete();
      
      return true;
    } catch (error) {
      logger.error('Error deleting query:', error);
      throw error;
    }
  }

  static async getAnalytics(user_id = null) {
    try {
      let baseQuery = db('chat_queries');
      
      if (user_id) {
        baseQuery = baseQuery.where({ user_id });
      }

      const [totalCount] = await baseQuery.clone().count('* as count');
      const [completedCount] = await baseQuery.clone().where({ status: 'completed' }).count('* as count');
      const [rejectedCount] = await baseQuery.clone().where({ status: 'rejected' }).count('* as count');
      const [savedCount] = await baseQuery.clone().where({ is_saved: true }).count('* as count');

      const queriesPerDay = await baseQuery.clone()
        .select(db.raw("DATE(created_date) as date"))
        .count('* as count')
        .groupBy('date')
        .orderBy('date', 'desc')
        .limit(30);

      const topVisualizations = await baseQuery.clone()
        .select('visualization_type')
        .count('* as count')
        .whereNotNull('visualization_type')
        .groupBy('visualization_type')
        .orderBy('count', 'desc');

      return {
        total: parseInt(totalCount.count),
        completed: parseInt(completedCount.count),
        rejected: parseInt(rejectedCount.count),
        saved: parseInt(savedCount.count),
        queries_per_day: queriesPerDay,
        top_visualizations: topVisualizations
      };
    } catch (error) {
      logger.error('Error getting analytics:', error);
      throw error;
    }
  }
}