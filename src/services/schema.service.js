import { mysqlDb } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { schemaCache } from '../utils/schemaCache.js';

// ─── System table prefixes to always exclude ──────────────────────────────────
// These are Django internals, auth, email infra — never relevant to business queries
const SYSTEM_TABLE_PREFIXES = [
  'auth_', 'django_', 'email_service_', 'excel_upload_',
];

const SYSTEM_TABLE_EXACT = new Set([
  'result_cache', 'asset_pos', 'asset_validation',
  'data_platform_otp', 'data_platform_usersettings',
  'data_platform_companyaudit', 'data_platform_companyapproval',
  'data_platform_companywatch', 'data_platform_companywatchlistupdates',
  'data_platform_companyimage', 'data_platform_samplecompany',
  'data_platform_googlenewsarticles',
]);

// Columns that are never useful for business queries
const EXCLUDE_COLUMNS = new Set([
  'created_at', 'updated_at', 'deleted_at', 'modified_at',
  'created_by', 'updated_by', 'changed_at', 'changed_by',
  'sort_order', 'meta', 'raw_json',
  'password', 'otp_code', 'access_token', 'refresh_token', 'id_token',
  'client_secret', 'session_data', 'session_key',
  'CompanyLogo', 'CompanyGoogleAlert', 'CompanyFacebookLink',
  'CompanyTwitterLink', 'CompanyInstagramLink', 'CompanyLinkedinLink',
  'CompanyTikTokLink', 'BlogPageURL', 'PipelineTechURL',
  'NewsPRMediaURL', 'ScientificPaperURL', 'TeamPageURL',
  'VideoLink', 'CompanyHide',
]);

// Views that should always be preferred over their base tables
// Priority: higher = included first when scoring is tied
const VIEW_PRIORITY = {
  v_companies: 10,
  v_company_asset: 10,
  v_therapeutic_area: 8,
  v_hallmark_of_aging: 8,
  v_asset_validation_summary: 6,
  v_validation_dashboard: 6,
  v_validation_review_queue: 6,
  v_latest_asset_validation: 5,
  company_aggregate: 4,
};

// Max tables to include in a single prompt
const MAX_TABLES_IN_CONTEXT = 3;

// ─────────────────────────────────────────────────────────────────────────────

export class SchemaService {

  // ─── In-memory catalog built once from DB ────────────────────────────────────
  // Structure: Map<tableName, { type, columns, foreignKeys, jsonColumns, keywordSet }>
  static _catalog = null;

  // ─── Entry point: schema string for a specific question ──────────────────────
  static async getSchemaForQuestion(question) {
    await this._ensureCatalog();

    const lower = question.toLowerCase();
    const matched = this._scoreAndSelectTables(lower);

    logger.info('Schema context selected', {
      question: question.substring(0, 80),
      tables: matched.map(t => t.name),
    });

    const parts = matched.map(t => this._renderTableBlock(t));

    const schema = [
      '# DATABASE SCHEMA (MySQL) — Relevant tables only\n',
      ...parts,
      this._buildRules(matched),
      this._buildExamples(matched),
    ].join('\n');

    const tokens = Math.ceil(schema.length / 4);
    logger.info(`Schema built: ${schema.length} chars ~${tokens} tokens, ${matched.length} tables`);

    return schema;
  }

  // ─── Build the full catalog from DB (runs once, then cached) ─────────────────
  static async _ensureCatalog() {
    // Check in-memory first (fastest)
  if (this._catalog) return;

  // Check schemaCache (survives across requests, has TTL from config)
  const cached = schemaCache.get('catalog');
    if (cached) {
      this._catalog = cached;
      logger.debug('Schema catalog restored from cache');
      return;
    }

    logger.info('Building schema catalog from DB...');
    this._catalog = new Map();

    // 1. Get all tables and views
    const [objects] = await mysqlDb.raw(`
      SELECT 
        TABLE_NAME as name,
        TABLE_TYPE as type
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY 
        CASE TABLE_TYPE WHEN 'VIEW' THEN 0 ELSE 1 END,
        TABLE_NAME
    `);

    // 2. Get all columns in one query (not N queries)
    const [allColumns] = await mysqlDb.raw(`
      SELECT
        TABLE_NAME as tableName,
        COLUMN_NAME as name,
        DATA_TYPE as dataType,
        COLUMN_TYPE as columnType,
        COLUMN_KEY as \`key\`,
        IS_NULLABLE as nullable
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `);

    // 3. Get all foreign keys in one query
    const [allFKs] = await mysqlDb.raw(`
      SELECT
        TABLE_NAME as tableName,
        COLUMN_NAME as columnName,
        REFERENCED_TABLE_NAME as refTable,
        REFERENCED_COLUMN_NAME as refColumn
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND REFERENCED_TABLE_NAME IS NOT NULL
    `);

    // Group columns and FKs by table
    const columnsByTable = this._groupBy(allColumns, 'tableName');
    const fksByTable = this._groupBy(allFKs, 'tableName');

    // 4. Build catalog entries
    for (const obj of objects) {
      if (this._isSystemTable(obj.name)) continue;

      const rawColumns = (columnsByTable[obj.name] || [])
        .filter(c => !EXCLUDE_COLUMNS.has(c.name));

      const foreignKeys = fksByTable[obj.name] || [];

      // Detect JSON columns
      const jsonColumns = rawColumns
        .filter(c => c.dataType === 'json' || c.columnType?.toLowerCase() === 'json')
        .map(c => c.name);

      // Build keyword set from table name + column names (auto-discovery)
      const keywordSet = this._buildKeywordSet(obj.name, rawColumns);

      this._catalog.set(obj.name, {
        name: obj.name,
        isView: obj.type === 'VIEW',
        columns: rawColumns,
        foreignKeys,
        jsonColumns,
        keywordSet,
        priority: VIEW_PRIORITY[obj.name] || (obj.type === 'VIEW' ? 3 : 1),
      });
    }

    schemaCache.set('catalog', this._catalog);
    logger.info(`Catalog built: ${this._catalog.size} usable tables/views`);
  }

  // ─── Score all tables against the question, return top N ─────────────────────
  static _scoreAndSelectTables(lowerQuestion) {
    const scores = [];

    for (const [, entry] of this._catalog) {
      let score = 0;

      // Keyword match score
      for (const kw of entry.keywordSet) {
        if (lowerQuestion.includes(kw)) score += kw.length > 5 ? 2 : 1; // longer match = higher score
      }

      // View bonus — prefer views over base tables
      score += entry.priority;

      if (score > entry.priority) { // only include if question keywords actually matched
        scores.push({ ...entry, score });
      }
    }

    // Sort by score desc
    scores.sort((a, b) => b.score - a.score);

    // Always include v_companies as the anchor table (FK hub)
    const result = scores.slice(0, MAX_TABLES_IN_CONTEXT);
    // AFTER — only inject if results are weak (no strong match found)
    const topScore = result[0]?.score ?? 0;
    const hasCompanies = result.some(t => t.name === 'v_companies');
    const isAssetOnlyQuery = result.some(t => t.name === 'v_company_asset' && t.score > 8);

    if (!hasCompanies && !isAssetOnlyQuery && topScore < 6 && this._catalog.has('v_companies')) {
      if (result.length >= MAX_TABLES_IN_CONTEXT) result.pop();
      result.push({ ...this._catalog.get('v_companies'), score: 0 });
    }

    return result;
  }

  // ─── Auto-build keyword set from table name and column names ─────────────────
  static _buildKeywordSet(tableName, columns) {
    const keywords = new Set();

    // From table name: split on _ and lowercase
    const tableWords = tableName
      .replace(/^v_/, '')           // strip view prefix
      .replace(/^data_platform_/, '') // strip app prefix
      .split('_')
      .filter(w => w.length > 2);

    for (const word of tableWords) {
      keywords.add(word.toLowerCase());
    }

    // Add semantic aliases per table
    const TABLE_ALIASES = {
      v_companies:                  ['company', 'companies', 'startup', 'firm', 'organization', 'location', 'country', 'city', 'hq', 'founded', 'employees', 'financing', 'public', 'private', 'ownership'],
      v_company_asset:              ['drug', 'asset', 'pipeline', 'therapy', 'clinical', 'preclinical', 'trial', 'moa', 'modality', 'mechanism', 'indication', 'hallmark', 'phase', 'treatment', 'biologic', 'molecule'],
      data_platform_companypitchbook: ['funding', 'raised', 'valuation', 'investment', 'capital', 'finance', 'raise', 'deal', 'investor', 'series', 'ipo', 'revenue'],
      data_platform_company:        ['grant', 'grants', 'longevity', 'level', 'overview', 'platform', 'detection', 'prevention', 'renewal'],
      data_platform_people:         ['people', 'person', 'team', 'founder', 'ceo', 'executive', 'management', 'biography', 'position'],
      data_platform_companypatent:  ['patent', 'patents', 'intellectual', 'property', 'filing', 'expiration', 'ip'],
      data_platform_news:           ['news', 'article', 'headline', 'press', 'media', 'publication', 'published'],
      data_platform_pitchbookdeal:  ['deal', 'deals', 'round', 'series', 'investment round', 'financing round'],
      v_therapeutic_area:           ['therapeutic', 'area', 'cardiovascular', 'oncology', 'neurology', 'immunology', 'metabolic', 'indication'],
      v_hallmark_of_aging:          ['hallmark', 'aging', 'ageing', 'senescence', 'inflammation', 'epigenetic'],
      v_asset_validation_summary:   ['validation', 'validated', 'confidence', 'review', 'accuracy'],
      v_validation_dashboard:       ['dashboard', 'summary', 'statistics', 'overview', 'total', 'count'],
      company_aggregate:            ['categories', 'aggregate', 'categorized'],
      data_platform_companyasset:   ['asset', 'drug', 'pipeline', 'modality', 'phase'],
      data_platform_address:        ['address', 'location', 'street', 'city', 'state', 'zip', 'country'],
      data_platform_score:          ['score', 'rating', 'assessment', 'evaluation'],
    };

    const aliases = TABLE_ALIASES[tableName] || [];
    for (const alias of aliases) keywords.add(alias);

    // From column names: extract meaningful words
    for (const col of columns) {
      const words = col.name
        .replace(/([A-Z])/g, ' $1')    // split PascalCase: CompanyName → Company Name
        .replace(/_/g, ' ')             // split snake_case
        .toLowerCase()
        .split(' ')
        .filter(w => w.length > 3 && !STOP_WORDS.has(w));

      for (const w of words) keywords.add(w);
    }

    return keywords;
  }

  // ─── Render a compact table block for LLM ────────────────────────────────────
  static _renderTableBlock(entry) {
    const { name, isView, columns, foreignKeys, jsonColumns } = entry;
    const typeLabel = isView ? 'VIEW' : 'TABLE';

    // Column lines
    const colLines = columns.map(c => {
      const tags = [];
      if (c.key === 'PRI') tags.push('PK');
      // FK detection — handles both snake_case and PascalCase
      const isFk = foreignKeys.some(fk => fk.columnName === c.name);
      if (isFk) {
        const fk = foreignKeys.find(fk => fk.columnName === c.name);
        tags.push(`FK→${fk.refTable}.${fk.refColumn}`);
      }
      if (c.dataType === 'json') tags.push('JSON⚠️');
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
      return `  ${c.name} (${c.dataType})${tagStr}`;
    }).join('\n');

    // FK summary for join hints
    const fkLines = foreignKeys.length
      ? foreignKeys.map(fk =>
          `  JOIN ${fk.refTable} ON ${name}.${fk.columnName} = ${fk.refTable}.${fk.refColumn}`
        ).join('\n')
      : null;

    // JSON column callout
    const jsonNote = jsonColumns.length
      ? `⚠️ JSON columns: ${jsonColumns.join(', ')} → use JSON_CONTAINS(col, '"Value"') or JSON_EXTRACT(col, '$.key')`
      : null;

    return [
      `## ${name} (${typeLabel})`,
      colLines,
      jsonNote ? `> ${jsonNote}` : null,
      fkLines ? `> Joins available:\n${fkLines}` : null,
      '',
    ].filter(Boolean).join('\n');
  }

  // ─── Dynamic rules based on what tables were matched ─────────────────────────
  static _buildRules(tables) {
    const names = new Set(tables.map(t => t.name));
    const hasViews = tables.some(t => t.isView);
    const hasBaseTables = tables.some(t => !t.isView);
    const hasJsonCols = tables.some(t => t.jsonColumns.length > 0);
    const hasMixedCase = names.has('v_companies') && names.has('data_platform_company');
    const hasFunding = names.has('data_platform_companypitchbook');

    const rules = ['\n## RULES:'];

    rules.push('- Only SELECT statements. Always LIMIT results (max 50).');
    rules.push('- No GROUP BY without an aggregate (COUNT, SUM, AVG, MAX, MIN).');

    if (hasMixedCase) {
      rules.push('- v_companies uses lowercase columns (name, hq_country). data_platform_company uses PascalCase (CompanyName, EmployeesCount). Never mix columns between them.');
    }

    if (hasViews && hasBaseTables) {
      rules.push('- Prefer VIEWs over base tables — they already have joins and cleaner column names.');
    }

    if (hasJsonCols) {
      rules.push('- For JSON columns: filter with JSON_CONTAINS(col, \'"Value"\'), extract with JSON_EXTRACT(col, \'$.key\'), check existence with JSON_CONTAINS_PATH(col, \'one\', \'$.key\').');
      rules.push('- Do NOT use = or LIKE on JSON columns directly.');
    }

    if (hasFunding) {
      rules.push('- Funding amounts (PitchbookRaiseToDate, PitchbookLastKnownValuation) are in the currency stored — no unit conversion needed.');
    }

    return rules.join('\n');
  }

  // ─── Dynamic examples based on matched tables + their JSON columns ────────────
  static _buildExamples(tables) {
    const EXAMPLE_MAP = {
      v_companies: `SELECT name, hq_country, financing_status, employees FROM v_companies WHERE hq_country = 'USA' ORDER BY employees DESC LIMIT 20`,
      v_company_asset: `SELECT AssetName, DevelopmentPhase, TherapeuticIndication FROM v_company_asset WHERE JSON_CONTAINS(TherapeuticArea, '"Cardiovascular"') LIMIT 20`,
      data_platform_companypitchbook: `SELECT c.CompanyName, p.PitchbookRaiseToDate, p.PitchbookLastKnownValuation FROM data_platform_company c JOIN data_platform_companypitchbook p ON c.CompanyID = p.company_id ORDER BY p.PitchbookRaiseToDate DESC LIMIT 10`,
      v_therapeutic_area: `SELECT CategoryName FROM v_therapeutic_area ORDER BY CategoryName LIMIT 50`,
      v_hallmark_of_aging: `SELECT CategoryName FROM v_hallmark_of_aging ORDER BY CategoryName LIMIT 50`,
      data_platform_people: `SELECT p.PeopleName, p.PeoplePosition, c.CompanyName FROM data_platform_people p JOIN data_platform_company c ON p.company_id = c.CompanyID LIMIT 20`,
      data_platform_companypatent: `SELECT PatentTitle, PatentStatus, FilingDate FROM data_platform_companypatent WHERE PatentStatus = 'Active' LIMIT 20`,
      data_platform_news: `SELECT NewsHeadline, PublishedDate, NewsSource FROM data_platform_news WHERE approved = 'Yes' ORDER BY PublishedDate DESC LIMIT 20`,
      v_asset_validation_summary: `SELECT AssetName, CompanyName, OverallConfidence, ReviewStatus FROM v_asset_validation_summary WHERE ReviewStatus = 'Pending' ORDER BY ReviewPriority DESC LIMIT 20`,
      v_validation_dashboard: `SELECT TotalAssetsValidated, HighConfidenceCount, NeedsReviewCount FROM v_validation_dashboard LIMIT 1`,
      company_aggregate: `SELECT CompanyName, Categories FROM company_aggregate WHERE Categories LIKE '%Oncology%' LIMIT 20`,
    };

    const lines = tables
      .filter(t => EXAMPLE_MAP[t.name])
      .map(t => `-- ${t.name}:\n${EXAMPLE_MAP[t.name]}`);

    return lines.length
      ? `\n## EXAMPLE QUERIES:\n\`\`\`sql\n${lines.join('\n\n')}\n\`\`\``
      : '';
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────
  static _isSystemTable(name) {
    if (SYSTEM_TABLE_EXACT.has(name)) return true;
    return SYSTEM_TABLE_PREFIXES.some(prefix => name.startsWith(prefix));
  }

  static _groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      const k = item[key];
      if (!acc[k]) acc[k] = [];
      acc[k].push(item);
      return acc;
    }, {});
  }

  // ─── Public utility methods ───────────────────────────────────────────────────
  static async getTableColumns(tableName) {
    await this._ensureCatalog();
    return this._catalog.get(tableName)?.columns || [];
  }

  static async getTableForeignKeys(tableName) {
    await this._ensureCatalog();
    return this._catalog.get(tableName)?.foreignKeys || [];
  }

  static clearCache() {
    this._catalog = null;       // clear in-memory
    schemaCache.clear();        // clear cache (handles TTL timestamps too)
    logger.info('Schema catalog cleared — will rebuild on next request');
  }

  // Backward compat for health checks
  static async getSchemaDescription() {
    return this.getSchemaForQuestion('show me companies');
  }

  static async getSchemaStats(question = 'show me companies') {
    const schema = await this.getSchemaForQuestion(question);
    return {
      catalogSize: this._catalog?.size || 0,
      schemaSize: schema.length,
      estimatedTokens: Math.ceil(schema.length / 4),
    };
  }
}

// ─── Stop words — excluded from auto keyword extraction ──────────────────────
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'this', 'that', 'have',
  'date', 'flag', 'link', 'url', 'type', 'name', 'note', 'notes',
  'status', 'count', 'size', 'list', 'data', 'info', 'page',
  'body', 'text', 'json', 'bool', 'int', 'char', 'long',
]);