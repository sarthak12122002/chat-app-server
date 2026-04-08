import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export const authMiddleware = (required = false) => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        if (required) {
          return res.status(401).json({ error: 'Not authenticated' });
        }
        req.user = null;
        return next();
      }
      
      const token = authHeader.substring(7);
      
      try {
        const decoded = jwt.verify(token, config.jwt.secret);
        req.user = decoded;
        next();
      } catch (error) {
        if (required) {
          return res.status(401).json({ error: 'Invalid or expired token' });
        }
        req.user = null;
        next();
      }
    } catch (error) {
      logger.error('Auth middleware error:', error);
      res.status(500).json({ error: 'Authentication error' });
    }
  };
};