import { logger } from '../utils/logger.js';

export const validate = (schema) => {
  return async (req, res, next) => {
    try {
      const validated = await schema.parseAsync(req.body);
      req.validatedData = validated;
      next();
    } catch (error) {
      logger.warn('Validation error:', error.errors);
      res.status(400).json({
        error: 'Validation failed',
        details: error.errors
      });
    }
  };
};

export const validateQuery = (schema) => {
  return async (req, res, next) => {
    try {
      const validated = await schema.parseAsync(req.query);
      req.validatedQuery = validated;
      next();
    } catch (error) {
      logger.warn('Query validation error:', error.errors);
      res.status(400).json({
        error: 'Invalid query parameters',
        details: error.errors
      });
    }
  };
};