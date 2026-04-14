// src/services/toolRegistry.js

import { mysqlDb } from '../config/database.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

// ════════════════════════════════════════════════════════════════════════════
// MODULE-LEVEL STATE
// ════════════════════════════════════════════════════════════════════════════

// Store query results for pagination via fetch_result_rows
const resultStore = new Map(); // result_id → { rows, columns, timestamp }
const RESULT_TTL = 1000 * 60 * 60; // 1 hour

// Cache for lookup values to avoid repeated queries
const lookupCache = new Map(); // category_type → { values, timestamp }
const LOOKUP_TTL = 1000 * 60 * 60; // 1 hour

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  
  for (const [id, data] of resultStore.entries()) {
    if (now - data.timestamp > RESULT_TTL) {
      resultStore.delete(id);
    }
  }
  
  for (const [key, data] of lookupCache.entries()) {
    if (now - data.timestamp > LOOKUP_TTL) {
      lookupCache.delete(key);
    }
  }
}, 1000 * 60 * 15); // Clean every 15 minutes

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM TABLE EXCLUSIONS
// ════════════════════════════════════════════════════════════════════════════

const SYSTEM_TABLE_PREFIXES = [
  'auth_', 
  'django_', 
  'email_service_', 
  'excel_upload_'
];

const SYSTEM_TABLE_EXACT = new Set([
  'result_cache',
  'data_platform_otp',
  'data_platform_usersettings',
  'data_platform_samplecompany'
]);

// ════════════════════════════════════════════════════════════════════════════
// TABLE DESCRIPTIONS
// ════════════════════════════════════════════════════════════════════════════

const TABLE_DESCRIPTIONS = {
  v_companies: "Company profiles — HQ, employees, financing_status, ownership_status, founded_year",
  v_company_asset: "Drug pipeline assets — DevelopmentPhase, TherapeuticArea (JSON), HallmarkOfAging (JSON), TherapeuticModality, TherapeuticIndication",
  data_platform_companypitchbook: "Funding data — PitchbookRaiseToDate, PitchbookLastKnownValuation, investors",
  data_platform_people: "Founders and executives — PeopleName, PeoplePosition, company_id",
  data_platform_companypatent: "Patents — PatentTitle, PatentStatus, FilingDate",
  data_platform_news: "News articles — NewsHeadline, PublishedDate, NewsSource, approved",
  v_therapeutic_area: "Lookup table for all valid therapeutic area categories",
  v_hallmark_of_aging: "Lookup table for all valid hallmarks of aging categories",
  v_asset_validation_summary: "Asset validation status — OverallConfidence, ReviewStatus, ReviewPriority",
  v_validation_dashboard: "Aggregate validation stats — TotalAssetsValidated, HighConfidenceCount",
  company_aggregate: "Company categories — CompanyName, Categories (comma separated)",
  data_platform_company: "Base company table — CompanyName, CompanyType, CompanyHide, EmployeesCount",
  data_platform_companyasset: "Base asset table — AssetName, AssetStatus, company_id"
};

// ════════════════════════════════════════════════════════════════════════════
// 1. TOOLS ARRAY — LLM-VISIBLE TOOL DEFINITIONS
// ════════════════════════════════════════════════════════════════════════════

export const TOOLS = [
  {
    name: "execute_sql",
    description: `Execute a read-only SQL SELECT query against the longevity biotech database.

Safety: Only SELECT/WITH queries are allowed. INSERT/UPDATE/DELETE/DROP are blocked. Results are capped at limit rows.

REQUIRED FILTER: When querying data_platform_company, always include:
    WHERE c.CompanyHide = 0 AND c.CompanyType = 'biotech'

Returns: rows array, row_count, columns array, and error if any.`,
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "The SQL SELECT query to execute"
        },
        limit: {
          type: "integer",
          description: "Maximum number of rows to return",
          default: 50
        }
      },
      required: ["sql"]
    }
  },

  {
    name: "get_lookup_values",
    description: `Get all distinct category values for a given type. Call this BEFORE writing SQL to discover valid filter values.

category_type options:
  HA  - Hallmarks of Aging (e.g. Cellular senescence, Telomere attrition)
  TA  - Therapeutic Areas (e.g. Neurology, Oncology) 
  DP  - Development Phases (e.g. Clinical (Phase 1), Preclinical)
  TM  - Therapeutic Modalities (e.g. Small molecule, Gene therapy)
  TMG - Therapeutic Modality Groups`,
    inputSchema: {
      type: "object",
      properties: {
        category_type: {
          type: "string",
          description: "Category type code: HA, TA, DP, TM, or TMG",
          enum: ["HA", "TA", "DP", "TM", "TMG"]
        }
      },
      required: ["category_type"]
    }
  },

  {
    name: "list_tables",
    description: `List all available database tables and views with their descriptions and join hints. Use describe_table to get column details for any listed table.`,
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },

  {
    name: "get_distinct_values",
    description: `Get distinct non-null values for any column in any table. Use this to discover valid filter values for free-text fields like BiologicTargetSystem, hq_country, CompanyName etc. Call this BEFORE filtering on any column you are unsure about.`,
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Name of the table"
        },
        column_name: {
          type: "string",
          description: "Name of the column"
        },
        limit: {
          type: "integer",
          description: "Maximum number of distinct values to return",
          default: 50
        }
      },
      required: ["table_name", "column_name"]
    }
  },

  {
    name: "describe_table",
    description: `Get full column definitions (name, data type, key info) for a specific table or view. Call this when you need to know exact column names before writing SQL.`,
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Name of the table to describe"
        }
      },
      required: ["table_name"]
    }
  },

  {
    name: "get_sample_rows",
    description: `Get sample rows from a table to understand its data shape and content. Use this when unsure about data format or column content.`,
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Name of the table"
        },
        limit: {
          type: "integer",
          description: "Number of sample rows to return",
          default: 5
        }
      },
      required: ["table_name"]
    }
  },

  {
    name: "fetch_result_rows",
    description: `Fetch rows from a previously executed query result using a result_id. Use offset/limit to page through large result sets.`,
    inputSchema: {
      type: "object",
      properties: {
        result_id: {
          type: "string",
          description: "Result ID from a previous execute_sql call"
        },
        offset: {
          type: "integer",
          description: "Starting row index (0-based)",
          default: 0
        },
        limit: {
          type: "integer",
          description: "Number of rows to return",
          default: 20
        }
      },
      required: ["result_id"]
    }
  },

  {
    name: "visualize",
    description: `Decide the visualization type and chart config for a result set. Call this AFTER execute_sql to choose the best chart type based on the actual data shape returned.

chart_type options: table, bar_chart, pie_chart, line_chart, metric`,
    inputSchema: {
      type: "object",
      properties: {
        result_id: {
          type: "string",
          description: "Result ID from execute_sql (optional if you already know the shape)",
          default: ""
        },
        chart_type: {
          type: "string",
          description: "Chart type to use",
          enum: ["table", "bar_chart", "pie_chart", "line_chart", "metric"],
          default: "table"
        },
        x_key: {
          type: "string",
          description: "Column name for x-axis",
          default: ""
        },
        y_key: {
          type: "string",
          description: "Column name for y-axis",
          default: ""
        },
        title: {
          type: "string",
          description: "Chart title",
          default: "Query Results"
        }
      },
      required: []
    }
  },

  {
    name: "query_and_visualize",
    description: `Execute a SQL query AND decide visualization in one step. Use this shortcut for simple questions where you already know the right SQL and visualization type. Prefer execute_sql + visualize separately for complex queries where you want to inspect data first.`,
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "The SQL SELECT query to execute"
        },
        chart_type: {
          type: "string",
          description: "Chart type to use",
          enum: ["table", "bar_chart", "pie_chart", "line_chart", "metric"],
          default: "table"
        },
        x_key: {
          type: "string",
          description: "Column name for x-axis",
          default: ""
        },
        y_key: {
          type: "string",
          description: "Column name for y-axis",
          default: ""
        },
        title: {
          type: "string",
          description: "Chart title",
          default: "Query Results"
        },
        limit: {
          type: "integer",
          description: "Maximum number of rows to return",
          default: 50
        }
      },
      required: ["sql"]
    }
  }
];

// ════════════════════════════════════════════════════════════════════════════
// 2. TOOL EXECUTION FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────
// Helper: Check if table is a system table
// ──────────────────────────────────────────────────────────────────────────
function isSystemTable(tableName) {
  if (SYSTEM_TABLE_EXACT.has(tableName)) return true;
  return SYSTEM_TABLE_PREFIXES.some(prefix => tableName.startsWith(prefix));
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: Validate column name (alphanumeric + underscore only)
// ──────────────────────────────────────────────────────────────────────────
function isValidColumnName(name) {
  return /^[a-zA-Z0-9_]+$/.test(name);
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: Strip existing LIMIT and add new one
// ──────────────────────────────────────────────────────────────────────────
function addLimitToQuery(sql, limit) {
  // Remove existing LIMIT clause (case insensitive)
  const stripped = sql.replace(/\s+LIMIT\s+\d+\s*;?\s*$/i, '').trim();
  // Add new LIMIT
  return `${stripped} LIMIT ${limit}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: Infer best chart type from data shape
// ──────────────────────────────────────────────────────────────────────────
function inferChartType(rows, columns) {
  if (!rows || rows.length === 0) return 'table';
  
  const colCount = columns.length;
  const rowCount = rows.length;
  
  // Single row, single numeric column → metric
  if (rowCount === 1 && colCount === 1) {
    const value = rows[0][columns[0]];
    if (typeof value === 'number') return 'metric';
  }
  
  // Check for date/time columns
  const hasDateColumn = columns.some(col => 
    /date|year|month|time|day/i.test(col)
  );
  if (hasDateColumn && colCount >= 2) return 'line_chart';
  
  // Two columns where second is numeric, many rows → bar_chart
  if (colCount === 2 && rowCount > 1) {
    const firstRow = rows[0];
    const secondColValue = firstRow[columns[1]];
    if (typeof secondColValue === 'number') {
      // Check if looks like percentage/ratio data
      const allValues = rows.map(r => r[columns[1]]);
      const allBetweenZeroAndHundred = allValues.every(v => v >= 0 && v <= 100);
      if (allBetweenZeroAndHundred && rowCount <= 10) return 'pie_chart';
      return 'bar_chart';
    }
  }
  
  return 'table';
}

// ══════════════════════════════════════════════════════════════════════════
// TOOL 1: execute_sql
// ══════════════════════════════════════════════════════════════════════════
async function executeSQL(toolInput) {
  try {
    const { sql, limit = 50 } = toolInput;
    
    // Security: Only allow SELECT/WITH queries
    const trimmedSQL = sql.trim();
    const startsWithSelect = /^(SELECT|WITH)/i.test(trimmedSQL);
    
    if (!startsWithSelect) {
      return {
        error: "Only SELECT and WITH queries are allowed. INSERT/UPDATE/DELETE/DROP are blocked.",
        sql: trimmedSQL
      };
    }
    
    // Add/replace LIMIT clause
    const finalLimit = Math.min(limit, 50);
    const limitedSQL = addLimitToQuery(trimmedSQL, finalLimit);
    
    logger.info('Executing SQL via tool', { sql: limitedSQL.substring(0, 100) });
    
    // Execute query
    const [rows] = await mysqlDb.raw(limitedSQL);
    
    // Extract column names
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    
    // Store result for pagination
    const resultId = crypto.randomUUID();
    resultStore.set(resultId, {
      rows,
      columns,
      timestamp: Date.now()
    });
    
    logger.info('SQL executed successfully', { 
      resultId, 
      rowCount: rows.length,
      columns: columns.length 
    });
    
    return {
      rows,
      row_count: rows.length,
      columns,
      result_id: resultId
    };
    
  } catch (error) {
    logger.error('SQL execution error:', error);
    return {
      error: error.message,
      sql: toolInput.sql
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TOOL 2: get_lookup_values
// ══════════════════════════════════════════════════════════════════════════
async function getLookupValues(toolInput) {
  try {
    const { category_type } = toolInput;
    
    // Check cache first
    const cached = lookupCache.get(category_type);
    if (cached && (Date.now() - cached.timestamp) < LOOKUP_TTL) {
      logger.debug(`Lookup cache hit for ${category_type}`);
      return {
        values: cached.values,
        count: cached.values.length,
        category_type,
        cached: true
      };
    }
    
    let values = [];
    
    switch (category_type) {
      case 'HA': // Hallmarks of Aging
        const [haRows] = await mysqlDb.raw(`
          SELECT DISTINCT jt.hallmark_value 
          FROM v_company_asset,
          JSON_TABLE(
            COALESCE(HallmarkOfAging, '[]'),
            '$[*]' COLUMNS(hallmark_value VARCHAR(255) PATH '$')
          ) AS jt
          WHERE jt.hallmark_value IS NOT NULL
          ORDER BY jt.hallmark_value
        `);
        values = haRows.map(r => r.hallmark_value);
        break;
        
      case 'TA': // Therapeutic Areas
        const [taRows] = await mysqlDb.raw(`
          SELECT DISTINCT jt.area_value 
          FROM v_company_asset,
          JSON_TABLE(
            COALESCE(TherapeuticArea, '[]'),
            '$[*]' COLUMNS(area_value VARCHAR(255) PATH '$')
          ) AS jt
          WHERE jt.area_value IS NOT NULL
          ORDER BY jt.area_value
        `);
        values = taRows.map(r => r.area_value);
        break;
        
      case 'DP': // Development Phases
        const [dpRows] = await mysqlDb.raw(`
          SELECT DISTINCT DevelopmentPhase 
          FROM v_company_asset 
          WHERE DevelopmentPhase IS NOT NULL
          ORDER BY DevelopmentPhase
        `);
        values = dpRows.map(r => r.DevelopmentPhase);
        break;
        
      case 'TM': // Therapeutic Modalities
        const [tmRows] = await mysqlDb.raw(`
          SELECT DISTINCT TherapeuticModality 
          FROM v_company_asset 
          WHERE TherapeuticModality IS NOT NULL
          ORDER BY TherapeuticModality
        `);
        values = tmRows.map(r => r.TherapeuticModality);
        break;
        
      case 'TMG': // Therapeutic Modality Groups
        try {
          const [tmgRows] = await mysqlDb.raw(`
            SELECT DISTINCT TherapeuticModalityGroup 
            FROM v_company_asset 
            WHERE TherapeuticModalityGroup IS NOT NULL
            ORDER BY TherapeuticModalityGroup
          `);
          values = tmgRows.map(r => r.TherapeuticModalityGroup);
        } catch (err) {
          // Fallback to TM if TMG column doesn't exist
          logger.warn('TherapeuticModalityGroup column not found, falling back to TherapeuticModality');
          const [tmRows] = await mysqlDb.raw(`
            SELECT DISTINCT TherapeuticModality 
            FROM v_company_asset 
            WHERE TherapeuticModality IS NOT NULL
            ORDER BY TherapeuticModality
          `);
          values = tmRows.map(r => r.TherapeuticModality);
        }
        break;
        
      default:
        return {
          error: `Unknown category_type: ${category_type}. Valid options: HA, TA, DP, TM, TMG`
        };
    }
    
    // Cache the result
    lookupCache.set(category_type, {
      values,
      timestamp: Date.now()
    });
    
    logger.info(`Loaded ${values.length} lookup values for ${category_type}`);
    
    return {
      values,
      count: values.length,
      category_type
    };
    
  } catch (error) {
    logger.error('Lookup values error:', error);
    return {
      error: error.message,
      category_type: toolInput.category_type
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TOOL 3: list_tables
// ══════════════════════════════════════════════════════════════════════════
async function listTables() {
  try {
    const [rows] = await mysqlDb.raw(`
      SELECT 
        TABLE_NAME as name,
        TABLE_TYPE as type
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY 
        CASE TABLE_TYPE WHEN 'VIEW' THEN 0 ELSE 1 END,
        TABLE_NAME
    `);
    
    // Filter out system tables and add descriptions
    const tables = rows
      .filter(row => !isSystemTable(row.name))
      .map(row => ({
        name: row.name,
        type: row.type,
        description: TABLE_DESCRIPTIONS[row.name] || "Database table"
      }));
    
    logger.info(`Listed ${tables.length} tables`);
    
    return {
      tables,
      count: tables.length
    };
    
  } catch (error) {
    logger.error('List tables error:', error);
    return {
      error: error.message
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TOOL 4: get_distinct_values
// ══════════════════════════════════════════════════════════════════════════
async function getDistinctValues(toolInput) {
  try {
    const { table_name, column_name, limit = 50 } = toolInput;
    
    // Validate table exists and is not a system table
    if (isSystemTable(table_name)) {
      return {
        error: `Access to system table '${table_name}' is not allowed`
      };
    }
    
    // Validate column name (prevent SQL injection)
    if (!isValidColumnName(column_name)) {
      return {
        error: `Invalid column name: ${column_name}. Only alphanumeric characters and underscores allowed.`
      };
    }
    
    // Check table exists
    const [tableCheck] = await mysqlDb.raw(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = ?
    `, [table_name]);
    
    if (tableCheck.length === 0) {
      return {
        error: `Table not found: ${table_name}`
      };
    }
    
    // Get distinct values
    const finalLimit = Math.min(limit, 50);
    const [rows] = await mysqlDb.raw(`
      SELECT DISTINCT ?? as value
      FROM ??
      WHERE ?? IS NOT NULL
      ORDER BY 1
      LIMIT ?
    `, [column_name, table_name, column_name, finalLimit]);
    
    const values = rows.map(r => r.value);
    
    logger.info(`Retrieved ${values.length} distinct values from ${table_name}.${column_name}`);
    
    return {
      values,
      count: values.length,
      table: table_name,
      column: column_name
    };
    
  } catch (error) {
    logger.error('Get distinct values error:', error);
    return {
      error: error.message,
      table: toolInput.table_name,
      column: toolInput.column_name
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TOOL 5: describe_table
// ══════════════════════════════════════════════════════════════════════════
async function describeTable(toolInput) {
  try {
    const { table_name } = toolInput;
    
    // Check table exists
    const [tableCheck] = await mysqlDb.raw(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = ?
    `, [table_name]);
    
    if (tableCheck.length === 0) {
      return {
        error: `Table not found: ${table_name}`
      };
    }
    
    // Get column information
    const [columns] = await mysqlDb.raw(`
      SELECT
        COLUMN_NAME as name,
        DATA_TYPE as data_type,
        COLUMN_TYPE as column_type,
        COLUMN_KEY as key_type,
        IS_NULLABLE as is_nullable
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [table_name]);
    
    // Get foreign key information
    const [foreignKeys] = await mysqlDb.raw(`
      SELECT
        COLUMN_NAME as column_name,
        REFERENCED_TABLE_NAME as ref_table,
        REFERENCED_COLUMN_NAME as ref_column
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND REFERENCED_TABLE_NAME IS NOT NULL
    `, [table_name]);
    
    // Build foreign key map
    const fkMap = {};
    foreignKeys.forEach(fk => {
      fkMap[fk.column_name] = {
        references_table: fk.ref_table,
        references_column: fk.ref_column
      };
    });
    
    // Enhance column info with FK data
    const enhancedColumns = columns.map(col => ({
      name: col.name,
      data_type: col.data_type,
      column_type: col.column_type,
      is_key: col.key_type === 'PRI' ? 'PRIMARY' : col.key_type === 'MUL' ? 'FOREIGN' : 'NO',
      is_nullable: col.is_nullable === 'YES',
      foreign_key: fkMap[col.name] || null
    }));
    
    logger.info(`Described table ${table_name}: ${enhancedColumns.length} columns`);
    
    return {
      table_name,
      columns: enhancedColumns
    };
    
  } catch (error) {
    logger.error('Describe table error:', error);
    return {
      error: error.message,
      table_name: toolInput.table_name
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TOOL 6: get_sample_rows
// ══════════════════════════════════════════════════════════════════════════
async function getSampleRows(toolInput) {
  try {
    const { table_name, limit = 5 } = toolInput;
    
    // Validate table exists and is not system table
    if (isSystemTable(table_name)) {
      return {
        error: `Access to system table '${table_name}' is not allowed`
      };
    }
    
    const [tableCheck] = await mysqlDb.raw(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = ?
    `, [table_name]);
    
    if (tableCheck.length === 0) {
      return {
        error: `Table not found: ${table_name}`
      };
    }
    
    // Get sample rows
    const finalLimit = Math.min(limit, 10);
    const [rows] = await mysqlDb.raw(`SELECT * FROM ?? LIMIT ?`, [table_name, finalLimit]);
    
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    
    logger.info(`Retrieved ${rows.length} sample rows from ${table_name}`);
    
    return {
      table_name,
      rows,
      columns,
      row_count: rows.length
    };
    
  } catch (error) {
    logger.error('Get sample rows error:', error);
    return {
      error: error.message,
      table_name: toolInput.table_name
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TOOL 7: fetch_result_rows
// ══════════════════════════════════════════════════════════════════════════
async function fetchResultRows(toolInput) {
  try {
    const { result_id, offset = 0, limit = 20 } = toolInput;
    
    // Look up result in store
    const result = resultStore.get(result_id);
    
    if (!result) {
      return {
        error: "Result not found. Re-execute the query."
      };
    }
    
    const { rows, columns } = result;
    
    // Apply offset/limit windowing
    const start = offset;
    const end = Math.min(start + limit, rows.length);
    const pageRows = rows.slice(start, end);
    
    logger.info(`Fetched rows ${start}-${end} from result ${result_id}`);
    
    return {
      columns,
      data: pageRows,
      row_count: rows.length,
      offset: start,
      limit: end - start,
      has_more: end < rows.length
    };
    
  } catch (error) {
    logger.error('Fetch result rows error:', error);
    return {
      error: error.message,
      result_id: toolInput.result_id
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TOOL 8: visualize
// ══════════════════════════════════════════════════════════════════════════
async function visualize(toolInput) {
  try {
    const { 
      result_id = '', 
      chart_type = 'table', 
      x_key = '', 
      y_key = '', 
      title = 'Query Results' 
    } = toolInput;
    
    let inferredType = chart_type;
    let columns = [];
    let rowCount = 0;
    let finalXKey = x_key;
    let finalYKey = y_key;
    
    // If result_id provided, infer chart type from actual data
    if (result_id) {
      const result = resultStore.get(result_id);
      
      if (!result) {
        return {
          error: "Result not found. Provide valid result_id or specify chart_type manually."
        };
      }
      
      columns = result.columns;
      rowCount = result.rows.length;
      
      // Auto-infer if chart_type not explicitly set or is default
      if (chart_type === 'table' && result.rows.length > 0) {
        inferredType = inferChartType(result.rows, columns);
      }
      
      // Auto-set keys if not provided
      if (!x_key && columns.length > 0) {
        finalXKey = columns[0];
      }
      if (!y_key && columns.length > 1) {
        finalYKey = columns[1];
      }
    }
    
    logger.info('Visualization config created', { 
      chart_type: inferredType, 
      x_key: finalXKey, 
      y_key: finalYKey 
    });
    
    return {
      chart_type: inferredType,
      x_key: finalXKey,
      y_key: finalYKey,
      title,
      row_count: rowCount
    };
    
  } catch (error) {
    logger.error('Visualize error:', error);
    return {
      error: error.message
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TOOL 9: query_and_visualize
// ══════════════════════════════════════════════════════════════════════════
async function queryAndVisualize(toolInput) {
  try {
    const { 
      sql, 
      chart_type = 'table', 
      x_key = '', 
      y_key = '', 
      title = 'Query Results',
      limit = 50 
    } = toolInput;
    
    // Execute SQL first
    const sqlResult = await executeSQL({ sql, limit });
    
    if (sqlResult.error) {
      return sqlResult;
    }
    
    // Then create visualization config
    const vizResult = await visualize({
      result_id: sqlResult.result_id,
      chart_type,
      x_key,
      y_key,
      title
    });
    
    logger.info('Query and visualize completed', { 
      rowCount: sqlResult.row_count,
      chartType: vizResult.chart_type 
    });
    
    // Merge results
    return {
      rows: sqlResult.rows,
      row_count: sqlResult.row_count,
      columns: sqlResult.columns,
      result_id: sqlResult.result_id,
      chart_type: vizResult.chart_type,
      x_key: vizResult.x_key,
      y_key: vizResult.y_key,
      title: vizResult.title
    };
    
  } catch (error) {
    logger.error('Query and visualize error:', error);
    return {
      error: error.message
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN EXECUTOR
// ════════════════════════════════════════════════════════════════════════════

export async function executeTool(toolName, toolInput) {
  logger.info(`Executing tool: ${toolName}`, { input: toolInput });
  
  switch (toolName) {
    case 'execute_sql':
      return await executeSQL(toolInput);
      
    case 'get_lookup_values':
      return await getLookupValues(toolInput);
      
    case 'list_tables':
      return await listTables(toolInput);
      
    case 'get_distinct_values':
      return await getDistinctValues(toolInput);
      
    case 'describe_table':
      return await describeTable(toolInput);
      
    case 'get_sample_rows':
      return await getSampleRows(toolInput);
      
    case 'fetch_result_rows':
      return await fetchResultRows(toolInput);
      
    case 'visualize':
      return await visualize(toolInput);
      
    case 'query_and_visualize':
      return await queryAndVisualize(toolInput);
      
    default:
      logger.error(`Unknown tool: ${toolName}`);
      return {
        error: `Unknown tool: ${toolName}`
      };
  }
}