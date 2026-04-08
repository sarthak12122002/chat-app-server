import { QueryService } from '../services/query.service.js';
import { logger } from '../utils/logger.js';

export class QueryController {
  static async list(req, res, next) {
    try {
      const options = req.validatedQuery || {};
      
      // Optionally filter by user
      if (req.user) {
        options.user_id = req.user.id;
      }

      const queries = await QueryService.list(options);
      res.json(queries);
    } catch (error) {
      next(error);
    }
  }

  static async getById(req, res, next) {
    try {
      const { id } = req.params;
      const query = await QueryService.findById(id);

      if (!query) {
        return res.status(404).json({ error: 'Query not found' });
      }

      // Check ownership if auth is enabled
      if (req.user && query.user_id && query.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      res.json(query);
    } catch (error) {
      next(error);
    }
  }

  static async create(req, res, next) {
    try {
      const data = req.body;
      
      if (req.user) {
        data.user_id = req.user.id;
      }

      const query = await QueryService.create(data);
      res.status(201).json(query);
    } catch (error) {
      next(error);
    }
  }

  static async update(req, res, next) {
    try {
      const { id } = req.params;
      const updates = req.validatedData;

      const existing = await QueryService.findById(id);
      if (!existing) {
        return res.status(404).json({ error: 'Query not found' });
      }

      // Check ownership
      if (req.user && existing.user_id && existing.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const updated = await QueryService.update(id, updates);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req, res, next) {
    try {
      const { id } = req.params;

      const existing = await QueryService.findById(id);
      if (!existing) {
        return res.status(404).json({ error: 'Query not found' });
      }

      // Check ownership
      if (req.user && existing.user_id && existing.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      await QueryService.delete(id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}