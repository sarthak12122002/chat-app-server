import { logger } from '../utils/logger.js';

/**
 * Maps commonly confused column names to correct ones
 * This fixes LLM mistakes automatically before SQL execution
 */
export class ColumnMapperService {
  
  // Define exact column mappings for each table
  static TABLE_COLUMN_MAP = {
    // v_companies (view)
    'v_companies': {
      'CompanyName': 'name',
      'CompanyID': 'id',
      'CompanyDescription': 'description',
      'CompanyWebsite': 'website',
      'FinancingStatus': 'financing_status',
      'OwnershipStatus': 'ownership_status',
      'InvestmentRaisedToDate': 'investment_raised',
      'EmployeesCount': 'employees',
      'YearFounded': 'year_founded',
      'Country': 'hq_country',
      'City': 'hq_city',
      'LongevityLevel1': 'longevity_level_1',
      'LongevityLevel2': 'longevity_level_2',
      'LongevityLevel3': 'longevity_level_3',
      'GrantsFundingRcvd': 'grants_received',
      'GrantFundingDescription': 'grant_description',
      'ManagementOverview': 'management_overview',
      'DiscoveryPlatformDescription': 'discovery_platform'
    },
    
    // data_platform_company (base table)
    'data_platform_company': {
      'name': 'CompanyName',
      'id': 'CompanyID',
      'description': 'CompanyDescription',
      'website': 'CompanyWebsite',
      'financing_status': 'FinancingStatus',
      'ownership_status': 'OwnershipStatus',
      'investment_raised': 'InvestmentRaisedToDate',
      'employees': 'EmployeesCount',
      'year_founded': 'YearFounded',
      'hq_country': null, // doesn't exist in base table
      'Country': null, // doesn't exist
      'grants_received': 'GrantsFundingRcvd',
      'grant_description': 'GrantFundingDescription',
      'management_overview': 'ManagementOverview',
      'discovery_platform': 'DiscoveryPlatformDescription'
    },
    
    // v_company_asset (view)
    'v_company_asset': {
      'AssetID': 'CompanyAssetID',
      'company_id': 'company_id', // correct
      'DevelopmentPhase': 'DevelopmentPhase', // correct
      'Phase': 'DevelopmentPhase',
      'ClinicalPhase': 'ClinicalPhase', // correct
      'PreclinicalPhase': 'PreclinicalPhase', // correct
      'TherapeuticArea': 'TherapeuticArea', // JSON column
      'HallmarkOfAging': 'HallmarkOfAging' // JSON column
    },
    
    // data_platform_companyasset (base table)
    'data_platform_companyasset': {
      'AssetID': 'CompanyAssetID',
      'company_id': 'company_id'
    },
    
    // data_platform_companypitchbook
    'data_platform_companypitchbook': {
      'RaiseToDate': 'PitchbookRaiseToDate',
      'LastKnownValuation': 'PitchbookLastKnownValuation',
      'Employees': 'PitchbookEmployees',
      'YearFounded': 'PitchbookYearFounded',
      'Country': 'PitchbookHQCountry',
      'City': 'PitchbookHQCity'
    }
  };

  /**
   * Auto-correct column names in SQL query
   */
  static fixColumnNames(sql) {
    let fixedSql = sql;
    let fixes = [];

    // Extract table aliases and their corresponding tables
    const aliasMap = this.extractTableAliases(sql);

    // Find and replace incorrect column references
    // Pattern: table_alias.column_name or table_name.column_name
    const columnPattern = /(\b[a-z_]+)\.([a-z_]+\w*)/gi;
    
    fixedSql = sql.replace(columnPattern, (match, tableRef, columnName) => {
      // Determine actual table name (from alias or direct reference)
      const actualTable = aliasMap[tableRef.toLowerCase()] || tableRef;
      
      // Check if we have a mapping for this table
      const tableMap = this.TABLE_COLUMN_MAP[actualTable];
      if (!tableMap) {
        return match; // No mapping, keep original
      }

      // Check if this column needs correction
      const correctColumn = tableMap[columnName];
      
      if (correctColumn === null) {
        // Column doesn't exist in this table
        fixes.push({
          wrong: match,
          reason: `Column '${columnName}' does not exist in table '${actualTable}'`
        });
        return match; // Keep it to let MySQL throw proper error
      }
      
      if (correctColumn && correctColumn !== columnName) {
        // Column name needs correction
        const corrected = `${tableRef}.${correctColumn}`;
        fixes.push({
          wrong: match,
          correct: corrected,
          table: actualTable
        });
        return corrected;
      }

      return match; // Column is correct
    });

    // Also fix non-aliased column references in SELECT clause
    // This handles: SELECT name, FinancingStatus FROM v_companies
    const selectMatch = sql.match(/SELECT\s+(.*?)\s+FROM\s+(\w+)/i);
    if (selectMatch) {
      const selectClause = selectMatch[1];
      const tableName = selectMatch[2];
      const tableMap = this.TABLE_COLUMN_MAP[tableName];
      
      if (tableMap) {
        const columnParts = selectClause.split(',');
        const fixedColumns = columnParts.map(col => {
          const trimmed = col.trim();
          
          // Skip aggregate functions
          if (/count\(|sum\(|avg\(|max\(|min\(/i.test(trimmed)) {
            return col;
          }
          
          // Extract column name (ignore aliases)
          const colMatch = trimmed.match(/^([a-z_]\w*)(?:\s+as\s+|\s+|$)/i);
          if (colMatch) {
            const colName = colMatch[1];
            const correctCol = tableMap[colName];
            
            if (correctCol === null) {
              fixes.push({
                wrong: colName,
                reason: `Column '${colName}' does not exist in table '${tableName}'`
              });
              return col;
            }
            
            if (correctCol && correctCol !== colName) {
              fixes.push({
                wrong: colName,
                correct: correctCol,
                table: tableName
              });
              return trimmed.replace(colName, correctCol);
            }
          }
          
          return col;
        });
        
        if (fixes.length > 0) {
          fixedSql = fixedSql.replace(selectClause, fixedColumns.join(', '));
        }
      }
    }

    if (fixes.length > 0) {
      logger.info('Auto-corrected column names', { 
        fixes,
        original: sql.substring(0, 100),
        fixed: fixedSql.substring(0, 100)
      });
    }

    return { sql: fixedSql, fixes };
  }

  /**
   * Extract table aliases from SQL
   * Returns: { alias: tableName }
   */
  static extractTableAliases(sql) {
    const aliasMap = {};
    
    // Pattern: FROM table_name alias or JOIN table_name alias
    const fromPattern = /(?:FROM|JOIN)\s+([a-z_]+)\s+(?:AS\s+)?([a-z_]+)(?:\s+ON|\s+WHERE|\s+GROUP|\s+ORDER|\s+LIMIT|,|$)/gi;
    
    let match;
    while ((match = fromPattern.exec(sql)) !== null) {
      const tableName = match[1];
      const alias = match[2];
      
      // Only add if alias is different from table name
      if (alias && alias.toLowerCase() !== tableName.toLowerCase()) {
        aliasMap[alias.toLowerCase()] = tableName;
      }
    }
    
    return aliasMap;
  }

  /**
   * Suggest correct query when column doesn't exist
   */
  static suggestCorrection(errorMessage, sql) {
    // Extract column name from error: "Unknown column 'c.name'"
    const match = errorMessage.match(/Unknown column '([^']+)'/);
    if (!match) return null;

    const wrongRef = match[1];
    const [tableRef, columnName] = wrongRef.split('.');
    
    if (!tableRef || !columnName) return null;

    // Find actual table
    const aliasMap = this.extractTableAliases(sql);
    const actualTable = aliasMap[tableRef.toLowerCase()] || tableRef;
    
    // Get mapping
    const tableMap = this.TABLE_COLUMN_MAP[actualTable];
    if (!tableMap) return null;

    const correctColumn = tableMap[columnName];
    
    if (correctColumn) {
      return {
        wrongColumn: wrongRef,
        correctColumn: `${tableRef}.${correctColumn}`,
        table: actualTable,
        suggestion: sql.replace(wrongRef, `${tableRef}.${correctColumn}`)
      };
    }

    return null;
  }
}