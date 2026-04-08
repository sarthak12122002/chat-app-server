import { mysqlDb } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { schemaCache } from '../utils/schemaCache.js';

export class SchemaService {
  /**
   * Get COMPACT schema description optimized for token limits
   */
  static async getSchemaDescription() {
    const cacheKey = 'schema_description_compact';
    const cached = schemaCache.get(cacheKey);
    if (cached) return cached;

    try {
      logger.info('Building compact schema description...');

      // Get only essential tables
      const essentialTables = await this.getEssentialTables();
      
      let schema = `# DATABASE SCHEMA (MySQL - Longevity/Biotech Platform)

## Core Tables (Use these for 90% of queries):

`;

      // Build ultra-compact descriptions
      for (const tableName of essentialTables) {
        const columns = await this.getTableColumns(tableName);
        const fks = await this.getTableForeignKeys(tableName);
        
        schema += `**${tableName}**\n`;
        
        // Only key columns
        const keyColumns = columns.filter(c => 
          c.key === 'PRI' || 
          c.name.toLowerCase().includes('name') ||
          c.name.toLowerCase().includes('id') ||
          c.name.toLowerCase().includes('phase') ||
          c.name.toLowerCase().includes('stage') ||
          c.name.toLowerCase().includes('status')
        );
        
        schema += keyColumns.map(c => `  ${c.name} (${this.getSimpleType(c)})`).join(', ') + '\n';
        
        if (fks.length > 0) {
          schema += `  FK: ${fks.map(fk => `${fk.columnName}→${fk.referencedTable}`).join(', ')}\n`;
        }
        schema += '\n';
      }

      schema += this.getQuickReference();

      schemaCache.set(cacheKey, schema);
      logger.info(`Schema built: ${schema.length} characters, ~${Math.ceil(schema.length / 4)} tokens`);
      
      return schema;
    } catch (error) {
      logger.error('Error building schema:', error);
      throw error;
    }
  }

  /**
   * Get minimal essential tables
   */
  static async getEssentialTables() {
    return [
      // Top 10 most used tables
      'v_companies',
      'v_company_asset',
      'data_platform_company',
      'data_platform_companyasset',
      'data_platform_companypitchbook',
      'data_platform_category',
      'v_therapeutic_area',
      'v_hallmark_of_aging',
      'asset_validation',
      'data_platform_pitchbookdeal'
    ];
  }

  /**
   * Get columns for a specific table
   */
  static async getTableColumns(tableName) {
    const cacheKey = `columns_${tableName}`;
    const cached = schemaCache.get(cacheKey);
    if (cached) return cached;

    try {
      const [columns] = await mysqlDb.raw(`
        SELECT 
          COLUMN_NAME as name,
          DATA_TYPE as dataType,
          COLUMN_TYPE as columnType,
          COLUMN_KEY as \`key\`
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `, [tableName]);

      schemaCache.set(cacheKey, columns);
      return columns;
    } catch (error) {
      logger.error(`Error fetching columns for ${tableName}:`, error);
      return [];
    }
  }

  /**
   * Get foreign keys for a table
   */
  static async getTableForeignKeys(tableName) {
    const cacheKey = `fk_${tableName}`;
    const cached = schemaCache.get(cacheKey);
    if (cached) return cached;

    try {
      const [foreignKeys] = await mysqlDb.raw(`
        SELECT 
          COLUMN_NAME as columnName,
          REFERENCED_TABLE_NAME as referencedTable,
          REFERENCED_COLUMN_NAME as referencedColumn
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND REFERENCED_TABLE_NAME IS NOT NULL
      `, [tableName]);

      schemaCache.set(cacheKey, foreignKeys);
      return foreignKeys;
    } catch (error) {
      logger.error(`Error fetching foreign keys for ${tableName}:`, error);
      return [];
    }
  }

  /**
   * Simplify column type
   */
  static getSimpleType(column) {
    const type = column.columnType.toLowerCase();
    
    if (type.includes('varchar')) return 'str';
    if (type.includes('int')) return 'int';
    if (type.includes('decimal')) return 'num';
    if (type.includes('tinyint(1)')) return 'bool';
    if (type.includes('json')) return 'json';
    if (type.includes('text')) return 'txt';
    if (type.includes('date')) return 'date';
    
    return column.dataType;
  }

  /**
   * Get quick reference guide
   */
  static getQuickReference() {
    return `
    ## Quick Reference:

    **Common Query Patterns:**

    1. Simple List:
      SELECT * FROM v_companies WHERE name LIKE '%biotech%' LIMIT 10

    2. Join with Details:
      SELECT c.CompanyName, c.CompanyWebsite, p.PitchbookRaiseToDate, p.PitchbookLastKnownValuation
      FROM data_platform_company c
      JOIN data_platform_companypitchbook p ON c.CompanyID = p.company_id
      WHERE p.PitchbookRaiseToDate IS NOT NULL
      ORDER BY p.PitchbookRaiseToDate DESC
      LIMIT 10

    3. Aggregation (COUNT, SUM, AVG):
      SELECT DevelopmentPhase, COUNT(*) as count
      FROM v_company_asset
      GROUP BY DevelopmentPhase
      ORDER BY count DESC

    4. Aggregation with JOIN:
      SELECT c.CompanyName, COUNT(a.CompanyAssetID) as asset_count
      FROM data_platform_company c
      LEFT JOIN data_platform_companyasset a ON c.CompanyID = a.company_id
      GROUP BY c.CompanyID, c.CompanyName
      ORDER BY asset_count DESC
      LIMIT 10

    5. Multiple Aggregations:
      SELECT 
        c.CompanyName,
        COUNT(DISTINCT a.CompanyAssetID) as total_assets,
        MAX(p.PitchbookRaiseToDate) as total_raised
      FROM data_platform_company c
      LEFT JOIN data_platform_companyasset a ON c.CompanyID = a.company_id
      LEFT JOIN data_platform_companypitchbook p ON c.CompanyID = p.company_id
      GROUP BY c.CompanyID, c.CompanyName
      HAVING total_raised > 0
      ORDER BY total_raised DESC
      LIMIT 10

    **CRITICAL GROUP BY RULES:**
    - ❌ WRONG: SELECT name, value FROM table GROUP BY name
    - ✅ RIGHT: SELECT name, SUM(value) as total FROM table GROUP BY name
    - ✅ RIGHT: SELECT name, MAX(value) as max_value FROM table GROUP BY name
    - When using GROUP BY, ALL non-aggregated columns must be in GROUP BY clause
    - Use COUNT(), SUM(), AVG(), MAX(), MIN() for aggregated values

    **Data Units:**
    - _b = billions USD (market_cap_b)
    - _m = millions USD (revenue_m, rd_spend_m)

    **MySQL Syntax:**
    - Use LIMIT not FETCH
    - Booleans: 1/0 not true/false
    - Dates: 'YYYY-MM-DD'
    - NULL checks: IS NULL / IS NOT NULL
    - String match: LIKE '%text%'

    **All Available Tables:** v_companies, v_company_asset, data_platform_company, data_platform_companyasset, data_platform_companypitchbook, data_platform_pitchbookdeal, data_platform_people, data_platform_companypatent, data_platform_news, data_platform_category, v_therapeutic_area, v_hallmark_of_aging, asset_validation, v_asset_validation_summary, data_platform_assetcategory, data_platform_assetclinicaltrial
    `;
  }

  /**
   * Get ALL tables list (for reference)
   */
  static async getAllTables() {
    const cacheKey = 'all_tables';
    const cached = schemaCache.get(cacheKey);
    if (cached) return cached;

    try {
      const [tables] = await mysqlDb.raw(`
        SELECT TABLE_NAME as name, TABLE_TYPE as type
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME NOT IN ('auth_group', 'auth_permission', 'django_admin_log', 'django_migrations', 'django_session', 'django_cache_table', 'django_content_type')
        ORDER BY TABLE_TYPE, TABLE_NAME
      `);

      schemaCache.set(cacheKey, tables);
      return tables;
    } catch (error) {
      logger.error('Error fetching tables:', error);
      throw error;
    }
  }

  /**
   * Get detailed info for specific table (on-demand)
   */
  static async getTableDetails(tableName) {
    const columns = await this.getTableColumns(tableName);
    const foreignKeys = await this.getTableForeignKeys(tableName);
    
    return {
      name: tableName,
      columns: columns.map(c => ({
        name: c.name,
        type: c.columnType,
        key: c.key
      })),
      foreignKeys: foreignKeys.map(fk => ({
        column: fk.columnName,
        references: `${fk.referencedTable}.${fk.referencedColumn}`
      }))
    };
  }

  /**
   * Clear cache
   */
  static clearCache() {
    schemaCache.clear();
  }

  /**
   * Get schema stats
   */
  static async getSchemaStats() {
    const tables = await this.getAllTables();
    const schema = await this.getSchemaDescription();
    
    return {
      totalTables: tables.filter(t => t.type === 'BASE TABLE').length,
      totalViews: tables.filter(t => t.type === 'VIEW').length,
      essentialTablesCount: (await this.getEssentialTables()).length,
      schemaSize: schema.length,
      estimatedTokens: Math.ceil(schema.length / 4)
    };
  }
}