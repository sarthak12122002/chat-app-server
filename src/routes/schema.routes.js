import express from 'express';
import { SchemaService } from '../services/schema.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Get schema description (for debugging)
router.get('/description', authMiddleware(false), async (req, res, next) => {
  try {
    const schema = await SchemaService.getSchemaDescription();
    res.json({ schema });
  } catch (error) {
    next(error);
  }
});

// Get table metadata
router.get('/metadata', authMiddleware(false), async (req, res, next) => {
  try {
    const metadata = await SchemaService.getTableMetadata();
    res.json(metadata);
  } catch (error) {
    next(error);
  }
});

// Get all tables
router.get('/tables', authMiddleware(false), async (req, res, next) => {
  try {
    const tables = await SchemaService.getAllTables();
    res.json({ tables });
  } catch (error) {
    next(error);
  }
});

// Get specific table details
router.get('/tables/:tableName', authMiddleware(false), async (req, res, next) => {
  try {
    const { tableName } = req.params;
    const columns = await SchemaService.getTableColumns(tableName);
    const foreignKeys = await SchemaService.getTableForeignKeys(tableName);
    const sample = await SchemaService.getSampleData(tableName, 3);

    res.json({
      table: tableName,
      columns,
      foreignKeys,
      sampleData: sample
    });
  } catch (error) {
    next(error);
  }
});

// Get schema statistics
router.get('/stats', authMiddleware(false), async (req, res, next) => {
  try {
    const stats = await SchemaService.getSchemaStats();
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

// Clear schema cache
router.post('/cache/clear', authMiddleware(true), async (req, res, next) => {
  try {
    SchemaService.clearCache();
    logger.info('Schema cache cleared by user', { userId: req.user?.id });
    res.json({ message: 'Schema cache cleared successfully' });
  } catch (error) {
    next(error);
  }
});

export default router;