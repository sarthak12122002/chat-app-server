import { logger } from './logger.js';
import { config } from '../config/index.js';

class SchemaCache {
  constructor() {
    this.cache = new Map();
    this.cacheTimestamps = new Map();
    this.cacheDuration = config.schema.cacheDurationMinutes * 60 * 1000; // Convert to ms
  }

  set(key, value) {
    this.cache.set(key, value);
    this.cacheTimestamps.set(key, Date.now());
    logger.debug(`Schema cache set: ${key}`);
  }

  get(key) {
    const timestamp = this.cacheTimestamps.get(key);
    
    if (!timestamp) {
      return null;
    }

    const age = Date.now() - timestamp;
    
    if (age > this.cacheDuration) {
      logger.debug(`Schema cache expired: ${key}`);
      this.cache.delete(key);
      this.cacheTimestamps.delete(key);
      return null;
    }

    logger.debug(`Schema cache hit: ${key}`);
    return this.cache.get(key);
  }

  clear() {
    this.cache.clear();
    this.cacheTimestamps.clear();
    logger.info('Schema cache cleared');
  }

  has(key) {
    return this.get(key) !== null;
  }
}

export const schemaCache = new SchemaCache();