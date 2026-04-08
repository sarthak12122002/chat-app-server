import { mysqlDb } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { schemaCache } from '../utils/schemaCache.js';

export class SchemaService {
  /**
   * ULTRA-COMPACT schema with EXACT column mappings for LLM
   */
  static async getSchemaDescription() {
    const cacheKey = 'schema_description_ultra_compact';
    const cached = schemaCache.get(cacheKey);
    if (cached) return cached;

    try {
      logger.info('Building ultra-compact schema...');

      const schema = `# LONGEVITY/BIOTECH DATABASE SCHEMA (MySQL)

      ## PRIMARY TABLES:

      **v_companies** (Main company view - USE THIS for company searches)
      Columns: id, name, description, website, financing_status, ownership_status, investment_raised, grants_received, grant_description, employees, year_founded, hq_city, hq_country, longevity_level_1, longevity_level_2, longevity_level_3, management_overview, discovery_platform
      ⚠️ All lowercase with underscores
      ⚠️ NO FinancingStatus - use financing_status
      ⚠️ NO Country - use hq_country

      **v_company_asset** (Drug pipeline - USE THIS for asset/drug queries)
      Columns: CompanyAssetID, AssetName, GenericName, DevelopmentPhase, ClinicalPhase, PreclinicalPhase, TherapeuticModality, TherapeuticModalityGroup, MechanismOfAction, TherapeuticArea (JSON), HallmarkOfAging (JSON), ClinicalTrialNumber (JSON), company_id
      FK: company_id → data_platform_company.CompanyID
      ⚠️ Use CompanyAssetID not AssetID
      ⚠️ JSON columns: TherapeuticArea, HallmarkOfAging, ClinicalTrialNumber

      **data_platform_company** (Full company table)
      Columns: CompanyID (PK), CompanyName, CompanyDescription, CompanyWebsite, FinancingStatus, OwnershipStatus, InvestmentRaisedToDate, EmployeesCount, YearFounded, GrantsFundingRcvd, GrantFundingDescription, ManagementOverview, DiscoveryPlatformDescription
      ⚠️ PascalCase or CapitalCase
      ⚠️ Use CompanyName not name
      ⚠️ NO hq_country column (join with v_companies for location)

      **data_platform_companypitchbook** (Financial data)
      Columns: CompanyPitchbookID, company_id, PitchbookRaiseToDate, PitchbookLastKnownValuation, PitchbookEmployees, PitchbookYearFounded, PitchbookHQCity, PitchbookHQCountry
      FK: company_id → data_platform_company.CompanyID
      ⚠️ This is where funding data lives

      **data_platform_companyasset** (Asset base table)
      Columns: CompanyAssetID, AssetName, GenericName, company_id, DevelopmentPhase_id, TherapeuticModality_id, ClinicalPhase, PreclinicalPhase
      FK: company_id → data_platform_company.CompanyID

      **v_therapeutic_area** (Categories)
      Columns: CategoryID, CategoryName

      **v_hallmark_of_aging** (Categories)
      Columns: CategoryID, CategoryName

      ## ⚠️ CRITICAL: EXACT COLUMN NAME TABLE

      | Need | v_companies | data_platform_company | Notes |
      |------|-------------|----------------------|-------|
      | Company name | \`name\` | \`CompanyName\` | Different! |
      | Company ID | \`id\` | \`CompanyID\` | Different! |
      | Financing | \`financing_status\` | \`FinancingStatus\` | Case! |
      | Employees | \`employees\` | \`EmployeesCount\` | Different! |
      | Country | \`hq_country\` | ❌ N/A | Only in view |
      | Grants | \`grants_received\` | \`GrantsFundingRcvd\` | Different! |

      | Need | v_company_asset | data_platform_companyasset |
      |------|----------------|---------------------------|
      | Asset ID | \`CompanyAssetID\` | \`CompanyAssetID\` | Same ✓ |
      | Phase | \`DevelopmentPhase\` | ❌ N/A | Only in view |

      ## EXAMPLE QUERIES:

      1. Companies by name (use v_companies):
      SELECT name, hq_country, financing_status 
      FROM v_companies 
      WHERE name LIKE '%biotech%' 
      LIMIT 10

      2. Companies with funding (use data_platform_company + pitchbook):
      SELECT c.CompanyName, p.PitchbookRaiseToDate 
      FROM data_platform_company c
      JOIN data_platform_companypitchbook p ON c.CompanyID = p.company_id
      WHERE p.PitchbookRaiseToDate > 500000000
      ORDER BY p.PitchbookRaiseToDate DESC 
      LIMIT 10

      3. Assets by therapeutic area (use v_company_asset with JSON):
      SELECT CompanyAssetID, AssetName, TherapeuticArea
      FROM v_company_asset
      WHERE JSON_CONTAINS(TherapeuticArea, '"Cardiovascular"')
      LIMIT 20

      4. Companies with grants:
      SELECT name, grant_description 
      FROM v_companies 
      WHERE grants_received = 1 
      LIMIT 20

      5. Public companies only:
      SELECT name, financing_status 
      FROM v_companies 
      WHERE financing_status LIKE '%Public%' 
      LIMIT 20

      ## RULES:

      1. **Check table carefully** - v_companies uses lowercase, data_platform_company uses PascalCase
      2. **NO GROUP BY without aggregates**
      3. **JSON columns** - Use JSON_CONTAINS() or JSON_EXTRACT() for TherapeuticArea/HallmarkOfAging
      4. **Always LIMIT** - Max 50 rows
      5. **Case sensitive** - financing_status ≠ FinancingStatus`;

      schemaCache.set(cacheKey, schema);
      const tokens = Math.ceil(schema.length / 4);
      logger.info(`Schema built: ${schema.length} chars, ~${tokens} tokens`);
      
      return schema;
    } catch (error) {
      logger.error('Error building schema:', error);
      throw error;
    }
  }
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

  static clearCache() {
    schemaCache.clear();
  }

  static async getSchemaStats() {
    const schema = await this.getSchemaDescription();
    
    return {
      schemaSize: schema.length,
      estimatedTokens: Math.ceil(schema.length / 4)
    };
  }
}