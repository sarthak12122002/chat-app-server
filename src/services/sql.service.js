import pkg from 'node-sql-parser';
import { mysqlDb } from '../config/database.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const { Parser } = pkg;

const parser = new Parser();

export class SQLService {
  static validateSafe(sql) {
    try {
      // Parse the SQL (MySQL mode)
      const ast = parser.astify(sql, { database: 'MySQL' });
      
      // Ensure it's a SELECT statement
      const statements = Array.isArray(ast) ? ast : [ast];
      
      for (const statement of statements) {
        if (statement.type !== 'select') {
          throw new Error('Only SELECT statements are allowed');
        }
        
        // Check for dangerous keywords
        const sqlLower = sql.toLowerCase();
        const dangerousPatterns = [
          'drop', 'delete', 'truncate', 'insert', 'update',
          'alter', 'create', 'grant', 'revoke', 'exec',
          'execute', 'call', 'load_file', 'into outfile'
        ];
        
        for (const pattern of dangerousPatterns) {
          if (sqlLower.includes(pattern)) {
            throw new Error(`Dangerous SQL keyword detected: ${pattern}`);
          }
        }

        // Validate GROUP BY usage
        this.validateGroupBy(sql, statement);
      }
      
      return true;
    } catch (error) {
      logger.error('SQL validation error:', error);
      throw new Error(`Invalid or unsafe SQL: ${error.message}`);
    }
  }

  /**
   * Validate GROUP BY clause
   */
  static validateGroupBy(sql, ast) {
    const sqlLower = sql.toLowerCase();
    
    // Check if query has GROUP BY
    if (!sqlLower.includes('group by')) {
      return; // No GROUP BY, validation not needed
    }

    // Extract all selected columns (simplified check)
    const selectMatch = sql.match(/select\s+(.*?)\s+from/i);
    if (!selectMatch) return;

    const selectClause = selectMatch[1];
    
    // Check if using aggregation functions
    const hasAggregates = /count\(|sum\(|avg\(|max\(|min\(|group_concat\(/i.test(selectClause);
    
    if (!hasAggregates && sqlLower.includes('group by')) {
      throw new Error('Invalid GROUP BY clause. When using GROUP BY, all non-aggregated columns must be included in GROUP BY or wrapped in aggregate functions like MAX(), MIN(), or ANY_VALUE().');
    }

    // Extract GROUP BY columns
    const groupByMatch = sql.match(/group\s+by\s+(.*?)(\s+having|\s+order|\s+limit|$)/i);
    if (!groupByMatch) return;

    const groupByColumns = groupByMatch[1].split(',').map(c => c.trim().toLowerCase());
    
    // Extract selected non-aggregate columns
    const selectedColumns = [];
    const columnParts = selectClause.split(',');
    
    for (const part of columnParts) {
      const trimmed = part.trim();
      
      // Skip aggregate functions
      if (/count\(|sum\(|avg\(|max\(|min\(|group_concat\(/i.test(trimmed)) {
        continue;
      }
      
      // Extract column name (handle aliases)
      const colMatch = trimmed.match(/([a-z0-9_\.`]+)(?:\s+as\s+|\s+)[a-z0-9_]+/i) || 
                       trimmed.match(/([a-z0-9_\.`]+)/i);
      
      if (colMatch) {
        const colName = colMatch[1].replace(/`/g, '').toLowerCase();
        if (colName !== '*' && !colName.includes('(')) {
          selectedColumns.push(colName);
        }
      }
    }

    // Check if all non-aggregate columns are in GROUP BY
    for (const col of selectedColumns) {
      const inGroupBy = groupByColumns.some(gb => 
        gb.includes(col) || col.includes(gb.split('.').pop())
      );
      
      if (!inGroupBy) {
        throw new Error(`Invalid GROUP BY clause. Column '${col}' must be included in GROUP BY or wrapped in an aggregate function.`);
      }
    }
  }

  static async execute(sql) {
    try {
      // Validate first
      this.validateSafe(sql);
      
      // Add LIMIT if not present
      const sqlLower = sql.toLowerCase();
      if (!sqlLower.includes('limit')) {
        sql = `${sql} LIMIT ${config.sql.maxResultRows}`;
      }
      
      // Execute on MySQL with timeout
      const [results] = await mysqlDb.raw(sql).timeout(config.sql.timeoutMs);
      
      logger.info('SQL executed successfully', { 
        sql: sql.substring(0, 100),
        rowCount: results.length 
      });
      
      return results || [];
    } catch (error) {
      logger.error('SQL execution failed:', { sql, error: error.message });
      
      if (error.message.includes('timeout')) {
        throw new Error('Query execution timeout. Please simplify your query.');
      }
      
      // MySQL specific errors
      if (error.message.includes('Unknown column')) {
        throw new Error(`Column not found: ${error.message}`);
      }
      
      if (error.message.includes('ONLY_FULL_GROUP_BY') || error.message.includes('group by')) {
        throw new Error('Invalid GROUP BY clause. When using GROUP BY, all non-aggregated columns must be included in GROUP BY or wrapped in aggregate functions like MAX(), MIN(), or ANY_VALUE().');
      }
      
      throw new Error(`SQL execution failed: ${error.message}`);
    }
  }

  /**
   * Auto-fix common GROUP BY issues
   */
  static autoFixGroupBy(sql) {
    try {
      const sqlLower = sql.toLowerCase();
      
      // If no GROUP BY, return as-is
      if (!sqlLower.includes('group by')) {
        return sql;
      }

      // Extract SELECT and GROUP BY clauses
      const selectMatch = sql.match(/select\s+(.*?)\s+from/i);
      const groupByMatch = sql.match(/group\s+by\s+(.*?)(\s+having|\s+order|\s+limit|$)/i);
      
      if (!selectMatch || !groupByMatch) {
        return sql;
      }

      const selectClause = selectMatch[1];
      const groupByClause = groupByMatch[1];
      const groupByColumns = groupByClause.split(',').map(c => c.trim());

      // Find columns that need to be added to GROUP BY
      const columnParts = selectClause.split(',');
      const columnsToAdd = [];

      for (const part of columnParts) {
        const trimmed = part.trim();
        
        // Skip aggregates
        if (/count\(|sum\(|avg\(|max\(|min\(/i.test(trimmed)) {
          continue;
        }

        // Extract column name
        const colMatch = trimmed.match(/([a-z0-9_\.`]+)(?:\s+as|\s+$)/i) || 
                         trimmed.match(/([a-z0-9_\.`]+)/i);
        
        if (colMatch) {
          const colName = colMatch[1];
          const inGroupBy = groupByColumns.some(gb => gb.includes(colName));
          
          if (!inGroupBy) {
            columnsToAdd.push(colName);
          }
        }
      }

      // Add missing columns to GROUP BY
      if (columnsToAdd.length > 0) {
        const newGroupBy = [...groupByColumns, ...columnsToAdd].join(', ');
        sql = sql.replace(/group\s+by\s+.*?(\s+having|\s+order|\s+limit|$)/i, 
                         `GROUP BY ${newGroupBy}$1`);
        
        logger.info('Auto-fixed GROUP BY clause', { 
          original: groupByClause,
          fixed: newGroupBy 
        });
      }

      return sql;
    } catch (error) {
      logger.warn('Failed to auto-fix GROUP BY:', error);
      return sql;
    }
  }

  static formatResultsForVisualization(rows, visualizationType) {
    if (!rows || rows.length === 0) {
      return [];
    }

    // For metric type, return single value
    if (visualizationType === 'metric') {
      const firstRow = rows[0];
      const firstValue = Object.values(firstRow)[0];
      return [{ value: firstValue }];
    }

    return rows;
  }

  static async testQuery(sql) {
    try {
      this.validateSafe(sql);
      const results = await this.execute(sql);
      return {
        success: true,
        rowCount: results.length,
        sample: results.slice(0, 3)
      };
    } catch (error) {
      // Try auto-fix
      try {
        const fixedSql = this.autoFixGroupBy(sql);
        if (fixedSql !== sql) {
          const results = await this.execute(fixedSql);
          return {
            success: true,
            rowCount: results.length,
            sample: results.slice(0, 3),
            autoFixed: true,
            originalSql: sql,
            fixedSql: fixedSql
          };
        }
      } catch (fixError) {
        // Auto-fix failed, return original error
      }

      return {
        success: false,
        error: error.message
      };
    }
  }
}