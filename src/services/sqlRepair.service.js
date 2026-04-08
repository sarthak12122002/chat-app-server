import { mysqlDb } from '../config/database.js';
import { logger } from '../utils/logger.js';

export class SQLRepairService {
  /**
   * Attempt to fix common SQL errors automatically
   */
  static async repairAndExecute(originalSql, error) {
    logger.info('Attempting SQL repair', { originalSql, error: error.message });

    // Check error type
    if (error.message.includes('not in GROUP BY clause')) {
      return await this.fixGroupByError(originalSql, error);
    }

    if (error.message.includes('Unknown column')) {
      return await this.fixUnknownColumn(originalSql, error);
    }

    // If we can't repair, throw original error
    throw error;
  }

  /**
   * Fix GROUP BY errors
   */
  static async fixGroupByError(sql, error) {
    logger.info('Attempting to fix GROUP BY error');

    // Strategy 1: Remove GROUP BY if not needed
    if (sql.includes('GROUP BY') && !this.hasAggregateFunction(sql)) {
      const repairedSql = sql.replace(/GROUP BY [^ORDER LIMIT]+/gi, '');
      logger.info('Repair attempt 1: Removed unnecessary GROUP BY', { repairedSql });
      
      try {
        const [results] = await mysqlDb.raw(repairedSql);
        logger.info('SQL repair successful - removed GROUP BY');
        return { results, repairedSql };
      } catch (e) {
        logger.warn('Repair attempt 1 failed', { error: e.message });
      }
    }

    // Strategy 2: Use ANY_VALUE() for non-aggregated columns
    const repairedSql = this.wrapNonAggregatedColumns(sql);
    if (repairedSql !== sql) {
      logger.info('Repair attempt 2: Added ANY_VALUE() wrappers', { repairedSql });
      
      try {
        const [results] = await mysqlDb.raw(repairedSql);
        logger.info('SQL repair successful - used ANY_VALUE()');
        return { results, repairedSql };
      } catch (e) {
        logger.warn('Repair attempt 2 failed', { error: e.message });
      }
    }

    // Strategy 3: Use DISTINCT instead of GROUP BY
    if (sql.includes('GROUP BY') && !this.hasAggregateFunction(sql)) {
      const repairedSql = sql
        .replace(/GROUP BY [^ORDER LIMIT]+/gi, '')
        .replace(/SELECT\s+/i, 'SELECT DISTINCT ');
      
      logger.info('Repair attempt 3: Used DISTINCT instead of GROUP BY', { repairedSql });
      
      try {
        const [results] = await mysqlDb.raw(repairedSql);
        logger.info('SQL repair successful - used DISTINCT');
        return { results, repairedSql };
      } catch (e) {
        logger.warn('Repair attempt 3 failed', { error: e.message });
      }
    }

    // All repair attempts failed
    throw error;
  }

  /**
   * Check if SQL has aggregate functions
   */
  static hasAggregateFunction(sql) {
    const aggregateFunctions = [
      'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 
      'GROUP_CONCAT', 'STDDEV', 'VARIANCE'
    ];
    
    const upperSql = sql.toUpperCase();
    return aggregateFunctions.some(func => upperSql.includes(func + '('));
  }

  /**
   * Wrap non-aggregated columns with ANY_VALUE()
   */
  static wrapNonAggregatedColumns(sql) {
    // This is a simplified approach - for production, use a proper SQL parser
    const selectMatch = sql.match(/SELECT\s+(.*?)\s+FROM/is);
    if (!selectMatch) return sql;

    const selectClause = selectMatch[1];
    const columns = selectClause.split(',').map(c => c.trim());

    const wrappedColumns = columns.map(col => {
      // Skip if already has aggregate function
      if (/COUNT|SUM|AVG|MAX|MIN|ANY_VALUE|GROUP_CONCAT/i.test(col)) {
        return col;
      }

      // Skip if it's just a table.column reference without alias
      if (/^\w+\.\w+$/.test(col)) {
        return `ANY_VALUE(${col})`;
      }

      // Handle aliases
      if (col.includes(' as ')) {
        const [colName, alias] = col.split(/\s+as\s+/i);
        if (!/COUNT|SUM|AVG|MAX|MIN|ANY_VALUE/i.test(colName)) {
          return `ANY_VALUE(${colName}) as ${alias}`;
        }
      }

      return col;
    });

    return sql.replace(selectMatch[0], `SELECT ${wrappedColumns.join(', ')} FROM`);
  }

  /**
   * Fix unknown column errors
   */
  static async fixUnknownColumn(sql, error) {
    logger.info('Attempting to fix unknown column error');
    
    // Extract column name from error
    const match = error.message.match(/Unknown column '([^']+)'/);
    if (!match) throw error;

    const unknownColumn = match[1];
    logger.warn('Unknown column detected', { unknownColumn });

    // For now, just throw - could add fuzzy matching later
    throw new Error(`Column '${unknownColumn}' does not exist. Please check the schema and try again.`);
  }
}