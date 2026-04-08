import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/index.js';
import { testConnections } from './config/database.js';
import { logger } from './utils/logger.js';
import { errorMiddleware } from './middleware/error.middleware.js';
import { generalRateLimiter } from './middleware/rateLimit.middleware.js';
import routes from './routes/index.js';

const app = express();

// Security middleware
app.use(helmet());

// CORS
app.use(cors({
  origin: '*',
  credentials: true
}));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting
app.use(generalRateLimiter);

// Request logging
app.use((req, res, next) => {
  logger.info('Incoming request', {
    method: req.method,
    path: req.path,
    ip: req.ip
  });
  next();
});

// Routes
app.use('/api', routes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handling
app.use(errorMiddleware);

// Start server
const startServer = async () => {
  try {
    // Test database connections
    const dbConnected = await testConnections();
    if (!dbConnected) {
      logger.error('Failed to connect to one or more databases. Exiting...');
      process.exit(1);
    }

    app.listen(config.port, '0.0.0.0',  () => {
      logger.info(`🚀 Server running on port ${config.port}`);
      logger.info(`📊 Environment: ${config.env}`);
      logger.info(`🤖 LLM Provider: ${config.llm.provider}`);
      logger.info(`🌐 Frontend URL: ${config.frontendUrl}`);
      logger.info(`💾 PostgreSQL: Application data (users, chat_queries)`);
      logger.info(`💾 MySQL: Biotech data (companies, trials, pipeline, etc.)`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});