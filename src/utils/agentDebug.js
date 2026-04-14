// src/utils/agentDebug.js

import { logger } from './logger.js';

/**
 * Log agent performance metrics for monitoring and optimization
 * 
 * @param {string} question - User's original question
 * @param {Object} result - Agent execution result from runAgentQuery
 * @returns {Object} Metrics object
 */
export function logAgentMetrics(question, result) {
  const metrics = {
    question: question.substring(0, 80),
    iterations: result.iterations,
    had_sql: !!result.sql,
    result_rows: result.result_data?.length || 0,
    visualization_type: result.visualization_type,
    incomplete: result.incomplete || false,
    error: result.error || null,
    // Calculate efficiency score (lower is better)
    efficiency_score: result.iterations / Math.max(1, result.result_data?.length || 1)
  };
  
  logger.info('[AGENT METRICS]', metrics);
  
  // Warn on potential issues
  if (result.iterations >= 7) {
    logger.warn('[AGENT PERFORMANCE] High iteration count', {
      iterations: result.iterations,
      question: question.substring(0, 80)
    });
  }
  
  if (result.incomplete) {
    logger.error('[AGENT FAILURE] Query incomplete - hit max iterations', {
      question: question.substring(0, 80),
      last_sql: result.sql
    });
  }
  
  if (!result.sql && !result.incomplete) {
    logger.warn('[AGENT WARNING] No SQL generated', {
      question: question.substring(0, 80)
    });
  }
  
  return metrics;
}

/**
 * Aggregate agent metrics over time (call this periodically or on shutdown)
 * 
 * @param {Array} metricsHistory - Array of metric objects from logAgentMetrics
 * @returns {Object} Aggregate statistics
 */
export function getAgentStats(metricsHistory) {
  if (!metricsHistory || metricsHistory.length === 0) {
    return {
      total_queries: 0,
      avg_iterations: 0,
      success_rate: 0,
      avg_result_rows: 0
    };
  }
  
  const total = metricsHistory.length;
  const avgIterations = metricsHistory.reduce((sum, m) => sum + m.iterations, 0) / total;
  const successCount = metricsHistory.filter(m => !m.incomplete && !m.error).length;
  const avgRows = metricsHistory.reduce((sum, m) => sum + m.result_rows, 0) / total;
  
  return {
    total_queries: total,
    avg_iterations: avgIterations.toFixed(2),
    success_rate: ((successCount / total) * 100).toFixed(2) + '%',
    avg_result_rows: avgRows.toFixed(2),
    incomplete_count: metricsHistory.filter(m => m.incomplete).length,
    error_count: metricsHistory.filter(m => m.error).length
  };
}