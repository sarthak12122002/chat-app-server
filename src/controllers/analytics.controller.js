import { QueryService } from '../services/query.service.js';

export class AnalyticsController {
  static async getSummary(req, res, next) {
    try {
      const userId = req.user?.id || null;
      const analytics = await QueryService.getAnalytics(userId);
      res.json(analytics);
    } catch (error) {
      next(error);
    }
  }
}