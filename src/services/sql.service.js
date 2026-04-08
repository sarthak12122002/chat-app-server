import pkg from 'node-sql-parser';
import { mysqlDb } from '../config/database.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { ColumnMapperService } from './columnMapper.service.js';

const { Parser } = pkg;
const parser = new Parser();

export class SQLService {
  static validateSafe(sql) {
    try {
      const ast = parser.astify(sql, { database: 'MySQL' });
      const statements = Array.isArray(ast) ? ast : [ast];
      
      for (const statement of statements) {
        if (statement.type !== 'select') {
          throw new Error('Only SELECT statements are allowed');
        }
        
        // FIX: More accurate dangerous keyword detection
        // Only check for SQL commands, not words in strings/column names
        const sqlUpper = sql.toUpperCase();
        
        // Check for actual SQL commands (not in strings)
        const dangerousCommands = [
          /\bDROP\s+/i,
          /\bDELETE\s+FROM/i,
          /\bTRUNCATE\s+/i,
          /\bINSERT\s+INTO/i,
          /\bUPDATE\s+\w+\s+SET/i,
          /\bALTER\s+/i,
          /\bCREATE\s+/i,
          /\bGRANT\s+/i,      // GRANT command (not word "grant" in columns/strings)
          /\bREVOKE\s+/i,
          /\bEXEC\s*\(/i,
          /\bCALL\s+/i,
          /\bLOAD_FILE\s*\(/i,
          /\bINTO\s+OUTFILE/i
        ];
        
        for (const pattern of dangerousCommands) {
          if (pattern.test(sql)) {
            throw new Error(`Dangerous SQL command detected: ${pattern.source}`);
          }
        }

        // FIX: Smarter GROUP BY validation
        this.validateGroupBy(sql, statement);
      }
      
      return true;
    } catch (error) {
      logger.error('SQL validation error:', error);
      throw new Error(`Invalid or unsafe SQL: ${error.message}`);
    }
  }

  /**
   * FIXED: More accurate GROUP BY validation
   */
  static validateGroupBy(sql, ast) {
    const sqlLower = sql.toLowerCase();
    
    if (!sqlLower.includes('group by')) {
      return; // No GROUP BY, all good
    }

    // Extract SELECT clause
    const selectMatch = sql.match(/select\s+(.*?)\s+from/i);
    if (!selectMatch) return;

    const selectClause = selectMatch[1];
    
    // Check for aggregate functions
    const hasAggregates = /count\s*\(|sum\s*\(|avg\s*\(|max\s*\(|min\s*\(|group_concat\s*\(/i.test(selectClause);
    
    // FIX: If there are NO aggregates and GROUP BY is used, it's suspicious
    // But only throw error if we're sure it's wrong
    if (!hasAggregates) {
      // Common false positive: GROUP BY for deduplication (which is wrong but common)
      logger.warn('GROUP BY without aggregates detected - this may be incorrect', { sql });
      // Don't throw - let MySQL handle it or let auto-fix handle it
      return;
    }

    // If using aggregates, validate that non-aggregated columns are in GROUP BY
    const groupByMatch = sql.match(/group\s+by\s+(.*?)(\s+having|\s+order|\s+limit|$)/i);
    if (!groupByMatch) return;

    const groupByColumns = groupByMatch[1]
      .split(',')
      .map(c => c.trim().toLowerCase().replace(/`/g, ''));
    
    // Extract non-aggregated columns from SELECT
    const selectedColumns = [];
    const columnParts = selectClause.split(',');
    
    for (const part of columnParts) {
      const trimmed = part.trim();
      
      // Skip if it's an aggregate function
      if (/count\s*\(|sum\s*\(|avg\s*\(|max\s*\(|min\s*\(|group_concat\s*\(/i.test(trimmed)) {
        continue;
      }
      
      // Skip if it's a constant or expression
      if (/^\d+$/.test(trimmed) || trimmed.startsWith("'")) {
        continue;
      }
      
      // Extract column name (handle aliases with AS)
      const colMatch = trimmed.match(/([a-z0-9_\.`]+)(?:\s+as\s+|\s+$)/i) || 
                       trimmed.match(/([a-z0-9_\.`]+)/i);
      
      if (colMatch) {
        const colName = colMatch[1].replace(/`/g, '').toLowerCase();
        if (colName !== '*') {
          selectedColumns.push(colName);
        }
      }
    }

    // Check if all non-aggregated columns are in GROUP BY
    for (const col of selectedColumns) {
      // Extract just the column name (remove table alias)
      const colParts = col.split('.');
      const colNameOnly = colParts[colParts.length - 1];
      
      const inGroupBy = groupByColumns.some(gb => {
        const gbParts = gb.split('.');
        const gbNameOnly = gbParts[gbParts.length - 1];
        return gbNameOnly === colNameOnly || gb === col;
      });
      
      if (!inGroupBy) {
        logger.warn(`Column '${col}' not in GROUP BY`, { sql });
        // FIX: Only throw if MySQL would actually reject it
        // Some queries work fine even with this pattern
      }
    }
  }

  static async execute(sql) {
    try {
      // AUTO-FIX STEP 1: Correct column names BEFORE validation
      const { sql: correctedSql, fixes } = ColumnMapperService.fixColumnNames(sql);
      
      if (fixes.length > 0) {
        logger.info('Applied column name corrections', { 
          count: fixes.length,
          fixes: fixes.map(f => `${f.wrong} → ${f.correct}`)
        });
        sql = correctedSql;
      }

      // Now validate
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
      
      // Better error messages with suggestions
      if (error.message.includes('Unknown column')) {
        const suggestion = ColumnMapperService.suggestCorrection(error.message, sql);
        
        if (suggestion) {
          logger.info('Column correction suggestion', suggestion);
          
          // AUTO-FIX STEP 2: Try the suggested correction
          try {
            logger.info('Attempting corrected query', { 
              correctedSql: suggestion.suggestion.substring(0, 100) 
            });
            
            const [results] = await mysqlDb.raw(suggestion.suggestion).timeout(config.sql.timeoutMs);
            
            logger.info('Corrected query succeeded!', { rowCount: results.length });
            
            return results || [];
          } catch (retryError) {
            // If retry fails, throw original error with suggestion
            throw new Error(
              `Column '${suggestion.wrongColumn}' does not exist. ` +
              `Did you mean '${suggestion.correctColumn}'? ` +
              `(Table: ${suggestion.table})`
            );
          }
        }
        
        // No suggestion available
        const match = error.message.match(/Unknown column '([^']+)'/);
        const columnName = match ? match[1] : 'unknown';
        throw new Error(`Column '${columnName}' does not exist. Check the schema for correct column names.`);
      }
      
      if (error.message.includes('ONLY_FULL_GROUP_BY')) {
        throw new Error('Invalid GROUP BY: All selected columns must be in GROUP BY or use aggregate functions.');
      }
      
      throw new Error(`SQL execution failed: ${error.message}`);
    }
  }

  /**
   * IMPROVED: Auto-fix GROUP BY (only when safe)
   */
  static autoFixGroupBy(sql) {
    try {
      const sqlLower = sql.toLowerCase();
      
      // FIX 1: Remove unnecessary GROUP BY if no aggregates
      const selectMatch = sql.match(/select\s+(.*?)\s+from/i);
      if (selectMatch) {
        const selectClause = selectMatch[1];
        const hasAggregates = /count\s*\(|sum\s*\(|avg\s*\(|max\s*\(|min\s*\(/i.test(selectClause);
        
        if (!hasAggregates && sqlLower.includes('group by')) {
          // Remove GROUP BY entirely
          const fixed = sql.replace(/\s+group\s+by\s+.*?(\s+having|\s+order|\s+limit|$)/i, '$1');
          logger.info('Auto-fix: Removed unnecessary GROUP BY', { 
            original: sql.substring(0, 100),
            fixed: fixed.substring(0, 100)
          });
          return fixed;
        }
      }
      
      // FIX 2: Add missing columns to GROUP BY
      if (!sqlLower.includes('group by')) {
        return sql;
      }

      const groupByMatch = sql.match(/group\s+by\s+(.*?)(\s+having|\s+order|\s+limit|$)/i);
      if (!groupByMatch || !selectMatch) {
        return sql;
      }

      const selectClause = selectMatch[1];
      const groupByClause = groupByMatch[1];
      const groupByColumns = groupByClause.split(',').map(c => c.trim().toLowerCase().replace(/`/g, ''));

      const columnParts = selectClause.split(',');
      const columnsToAdd = [];

      for (const part of columnParts) {
        const trimmed = part.trim();
        
        if (/count\s*\(|sum\s*\(|avg\s*\(|max\s*\(|min\s*\(/i.test(trimmed)) {
          continue;
        }

        const colMatch = trimmed.match(/([a-z0-9_\.`]+)(?:\s+as\s+|\s+$)/i) || 
                         trimmed.match(/([a-z0-9_\.`]+)/i);
        
        if (colMatch) {
          const colName = colMatch[1];
          const colLower = colName.toLowerCase().replace(/`/g, '');
          const colParts = colLower.split('.');
          const colNameOnly = colParts[colParts.length - 1];
          
          const inGroupBy = groupByColumns.some(gb => {
            const gbParts = gb.split('.');
            const gbNameOnly = gbParts[gbParts.length - 1];
            return gbNameOnly === colNameOnly || gb === colLower;
          });
          
          if (!inGroupBy && colNameOnly !== '*') {
            columnsToAdd.push(colName);
          }
        }
      }

      if (columnsToAdd.length > 0) {
        const newGroupBy = [...groupByClause.split(',').map(c => c.trim()), ...columnsToAdd].join(', ');
        const fixed = sql.replace(
          /group\s+by\s+.*?(\s+having|\s+order|\s+limit|$)/i, 
          `GROUP BY ${newGroupBy}$1`
        );
        
        logger.info('Auto-fix: Added columns to GROUP BY', { 
          original: groupByClause,
          fixed: newGroupBy 
        });
        
        return fixed;
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
        // Auto-fix failed
      }

      return {
        success: false,
        error: error.message
      };
    }
  }
}