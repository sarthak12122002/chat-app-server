import { mysqlDb } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { schemaCache } from '../utils/schemaCache.js';

// ─── System table prefixes to always exclude ──────────────────────────────────
const SYSTEM_TABLE_PREFIXES = [
  'auth_', 'django_', 'email_service_', 'excel_upload_',
];

const SYSTEM_TABLE_EXACT = new Set([
  'result_cache',
  'data_platform_otp', 'data_platform_usersettings',
  'data_platform_samplecompany'
]);

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

const MAX_TABLES_IN_CONTEXT = 4;

// ─── NEW: Semantic Query Classification Patterns ──────────────────────────────
const QUERY_PATTERNS = {
  FUNDING: {
    regex: /fund|raise|invest|capital|valuation|series|ipo|revenue|financial|money|million|billion/i,
    forceTables: ['data_platform_companypitchbook'],
    sampleFields: ['PitchbookRaiseToDate', 'PitchbookLastKnownValuation'],
  },
  CLINICAL: {
    regex: /phase|trial|fda|approved|clinical|preclinical|development|regulatory|marketed/i,
    forceTables: ['v_company_asset'],
    sampleFields: ['DevelopmentPhase', 'ClinicalPhase'],
  },
  GEOGRAPHIC: {
    regex: /countr|location|city|headquarter|hq|uk|usa|us|china|europe|asia|region|where.*based/i,
    forceTables: ['v_companies'],
    sampleFields: ['hq_country', 'hq_city'],
  },
  PIPELINE: {
    regex: /drug|asset|pipeline|therap|treatment|medicine|compound|molecule|indication|disease/i,
    forceTables: ['v_company_asset'],
    sampleFields: ['TherapeuticArea', 'TherapeuticModality'],
  },
  HALLMARK: {
    regex: /hallmark|aging|ageing|senescence|longevity|lifespan|healthspan|mtor|sasp|senolytic/i,
    forceTables: ['v_company_asset', 'v_hallmark_of_aging'],
    sampleFields: ['HallmarkOfAging'],
  },
  PEOPLE: {
    regex: /founder|ceo|executive|team|management|leader|person|people|scientist|researcher/i,
    forceTables: ['data_platform_people'],
    sampleFields: ['PeoplePosition'],
  },
  MODALITY: {
    regex: /modalit|antibod|small molecule|gene therap|cell therap|first.in.class|mechanism/i,
    forceTables: ['v_company_asset'],
    sampleFields: ['TherapeuticModality'],
  },
  OWNERSHIP: {
    regex: /public|private|ownership|stock|traded|financing.*status/i,
    forceTables: ['v_companies'],
    sampleFields: ['financing_status', 'ownership_status'],
  },
};

// ─── NEW: Sample value cache configuration ────────────────────────────────────
const SAMPLE_VALUE_CONFIG = {
  // JSON columns that need flattening
  HallmarkOfAging: {
    query: `
      SELECT DISTINCT jt.hallmark_value 
      FROM v_company_asset,
      JSON_TABLE(
        COALESCE(HallmarkOfAging, '[]'),
        '$[*]' COLUMNS(hallmark_value VARCHAR(255) PATH '$')
      ) AS jt
      WHERE jt.hallmark_value IS NOT NULL
      ORDER BY jt.hallmark_value
      LIMIT 12
    `,
    extractField: 'hallmark_value',
  },
  TherapeuticArea: {
    query: `
      SELECT DISTINCT jt.area_value 
      FROM v_company_asset,
      JSON_TABLE(
        COALESCE(TherapeuticArea, '[]'),
        '$[*]' COLUMNS(area_value VARCHAR(255) PATH '$')
      ) AS jt
      WHERE jt.area_value IS NOT NULL
      ORDER BY jt.area_value
      LIMIT 10
    `,
    extractField: 'area_value',
  },
  // Regular columns
  DevelopmentPhase: {
    table: 'v_company_asset',
    limit: 8,
  },
  ClinicalPhase: {
    table: 'v_company_asset',
    limit: 6,
  },
  TherapeuticModality: {
    table: 'v_company_asset',
    limit: 8,
  },
  hq_country: {
    table: 'v_companies',
    limit: 15,
  },
  hq_city: {
    table: 'v_companies',
    limit: 12,
  },
  financing_status: {
    table: 'v_companies',
    limit: 6,
  },
  ownership_status: {
    table: 'v_companies',
    limit: 4,
  },
  PitchbookRaiseToDate: {
    table: 'data_platform_companypitchbook',
    limit: 5,
    format: (val) => `$${(val / 1000000).toFixed(0)}M`, // Format as millions
  },
  PitchbookLastKnownValuation: {
    table: 'data_platform_companypitchbook',
    limit: 5,
    format: (val) => `$${(val / 1000000).toFixed(0)}M`,
  },
  PeoplePosition: {
    table: 'data_platform_people',
    limit: 8,
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export class SchemaService {

  // ─── In-memory catalog built once from DB ────────────────────────────────────
  // Structure: Map<tableName, { type, columns, foreignKeys, jsonColumns, keywordSet }>
  static _catalog = null;

  // ─── ENHANCED: Entry point with semantic classification ───────────────────────
  static async getSchemaForQuestion(question) {
    await this._ensureCatalog();

    const lower = question.toLowerCase();
    
    // NEW: Classify query semantically
    const classification = this._classifyQuery(lower);
    
    // Select tables (now informed by classification)
    const matched = this._scoreAndSelectTables(lower, classification);

    // NEW: Fetch sample values for matched tables
    const sampleValues = await this._fetchSampleValues(matched, classification);

    logger.info('Schema context selected', {
      question: question.substring(0, 80),
      classification: classification.types,
      tables: matched.map(t => t.name),
      samplesLoaded: Object.keys(sampleValues),
    });

    // Render table blocks with sample values
    const parts = matched.map(t => this._renderTableBlock(t, sampleValues));

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

  // ─── NEW: Semantic Query Classification ───────────────────────────────────────
  static _classifyQuery(lowerQuestion) {
    const types = [];
    const forceTables = new Set();
    const sampleFields = new Set();

    for (const [type, pattern] of Object.entries(QUERY_PATTERNS)) {
      if (pattern.regex.test(lowerQuestion)) {
        types.push(type);
        
        // Collect force-include tables
        for (const table of pattern.forceTables) {
          forceTables.add(table);
        }
        
        // Collect sample fields needed
        for (const field of pattern.sampleFields) {
          sampleFields.add(field);
        }
      }
    }

    logger.debug('Query classified', { 
      types, 
      forceTables: Array.from(forceTables),
      sampleFields: Array.from(sampleFields)
    });

    return {
      types,
      forceTables: Array.from(forceTables),
      sampleFields: Array.from(sampleFields),
    };
  }

  // ─── Build the full catalog from DB (runs once, then cached) ─────────────────
  static async _ensureCatalog() {
    if (this._catalog) return;

    const cached = schemaCache.get('catalog');
    if (cached) {
      this._catalog = cached;
      logger.debug('Schema catalog restored from cache');
      return;
    }

    logger.info('Building schema catalog from DB...');
    this._catalog = new Map();

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

    const columnsByTable = this._groupBy(allColumns, 'tableName');
    const fksByTable = this._groupBy(allFKs, 'tableName');

    for (const obj of objects) {
      if (this._isSystemTable(obj.name)) continue;

      const rawColumns = (columnsByTable[obj.name] || [])
        .filter(c => !EXCLUDE_COLUMNS.has(c.name));

      const foreignKeys = fksByTable[obj.name] || [];

      const jsonColumns = rawColumns
        .filter(c => c.dataType === 'json' || c.columnType?.toLowerCase() === 'json')
        .map(c => c.name);

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

  // ─── ENHANCED: Score tables with semantic classification boost ────────────────
  static _scoreAndSelectTables(lowerQuestion, classification) {
    const scores = [];

    for (const [, entry] of this._catalog) {
      let score = 0;

      // Keyword match score (existing logic)
      for (const kw of entry.keywordSet) {
        if (lowerQuestion.includes(kw)) score += kw.length > 5 ? 2 : 1;
      }

      // View bonus
      score += entry.priority;

      // NEW: Semantic classification boost
      if (classification.forceTables.includes(entry.name)) {
        score += 15; // Strong boost for semantically required tables
        logger.debug(`Semantic boost applied to ${entry.name}`, { boost: 15 });
      }

      if (score > entry.priority) {
        scores.push({ ...entry, score });
      }
    }

    // Sort by score desc
    scores.sort((a, b) => b.score - a.score);

    const result = scores.slice(0, MAX_TABLES_IN_CONTEXT);
    
    // Existing fallback logic
    const topScore = result[0]?.score ?? 0;
    const hasCompanies = result.some(t => t.name === 'v_companies');
    const isAssetOnlyQuery = result.some(t => t.name === 'v_company_asset' && t.score > 8);

    if (!hasCompanies && !isAssetOnlyQuery && topScore < 6 && this._catalog.has('v_companies')) {
      if (result.length >= MAX_TABLES_IN_CONTEXT) result.pop();
      result.push({ ...this._catalog.get('v_companies'), score: 0 });
    }

    return result;
  }

  // ─── NEW: Fetch sample values for relevant fields ─────────────────────────────
  static async _fetchSampleValues(tables, classification) {
    const samples = {};
    const fieldsToFetch = new Set(classification.sampleFields);

    // Add fields from selected tables' JSON columns
    for (const table of tables) {
      for (const jsonCol of table.jsonColumns) {
        if (SAMPLE_VALUE_CONFIG[jsonCol]) {
          fieldsToFetch.add(jsonCol);
        }
      }
    }

    // Fetch each field's sample values
    for (const field of fieldsToFetch) {
      const cacheKey = `sample_${field}`;
      const cached = schemaCache.get(cacheKey);

      if (cached) {
        samples[field] = cached;
        continue;
      }

      const config = SAMPLE_VALUE_CONFIG[field];
      if (!config) continue;

      try {
        let values = [];

        if (config.query) {
          // Custom query (for JSON columns)
          const [results] = await mysqlDb.raw(config.query);
          values = results.map(r => r[config.extractField]);
        } else if (config.table) {
          // Standard column query
          const [results] = await mysqlDb.raw(`
            SELECT DISTINCT ${field} 
            FROM ${config.table} 
            WHERE ${field} IS NOT NULL 
            ORDER BY ${field}
            LIMIT ${config.limit}
          `);
          values = results.map(r => {
            const val = r[field];
            return config.format ? config.format(val) : val;
          });
        }

        if (values.length > 0) {
          samples[field] = values;
          schemaCache.set(cacheKey, values);
          logger.debug(`Loaded ${values.length} sample values for ${field}`);
        }
      } catch (error) {
        logger.error(`Failed to fetch samples for ${field}:`, error);
      }
    }

    return samples;
  }

  // ─── Auto-build keyword set from table name and column names ─────────────────
  static _buildKeywordSet(tableName, columns) {
    const keywords = new Set();

    const tableWords = tableName
      .replace(/^v_/, '')
      .replace(/^data_platform_/, '')
      .split('_')
      .filter(w => w.length > 2);

    for (const word of tableWords) {
      keywords.add(word.toLowerCase());
    }

    const TABLE_ALIASES = {
      v_companies: ['company', 'companies', 'startup', 'firm', 'organization', 'location', 'country', 'city', 'hq', 'founded', 'employees', 'financing', 'public', 'private', 'ownership'],
      v_company_asset: ['drug', 'asset', 'pipeline', 'therapy', 'clinical', 'preclinical', 'trial', 'moa', 'modality', 'mechanism', 'indication', 'hallmark', 'phase', 'treatment', 'biologic', 'molecule'],
      data_platform_companypitchbook: ['funding', 'raised', 'valuation', 'investment', 'capital', 'finance', 'raise', 'deal', 'investor', 'series', 'ipo', 'revenue'],
      data_platform_company: ['grant', 'grants', 'longevity', 'level', 'overview', 'platform', 'detection', 'prevention', 'renewal'],
      data_platform_people: ['people', 'person', 'team', 'founder', 'ceo', 'executive', 'management', 'biography', 'position'],
      data_platform_companypatent: ['patent', 'patents', 'intellectual', 'property', 'filing', 'expiration', 'ip'],
      data_platform_news: ['news', 'article', 'headline', 'press', 'media', 'publication', 'published'],
      data_platform_pitchbookdeal: ['deal', 'deals', 'round', 'series', 'investment round', 'financing round'],
      v_therapeutic_area: ['therapeutic', 'area', 'cardiovascular', 'oncology', 'neurology', 'immunology', 'metabolic', 'indication'],
      v_hallmark_of_aging: ['hallmark', 'aging', 'ageing', 'senescence', 'inflammation', 'epigenetic'],
      v_asset_validation_summary: ['validation', 'validated', 'confidence', 'review', 'accuracy'],
      v_validation_dashboard: ['dashboard', 'summary', 'statistics', 'overview', 'total', 'count'],
      company_aggregate: ['categories', 'aggregate', 'categorized'],
      data_platform_companyasset: ['asset', 'drug', 'pipeline', 'modality', 'phase'],
      data_platform_address: ['address', 'location', 'street', 'city', 'state', 'zip', 'country'],
      data_platform_score: ['score', 'rating', 'assessment', 'evaluation'],
    };

    const aliases = TABLE_ALIASES[tableName] || [];
    for (const alias of aliases) keywords.add(alias);

    for (const col of columns) {
      const words = col.name
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .toLowerCase()
        .split(' ')
        .filter(w => w.length > 3 && !STOP_WORDS.has(w));

      for (const w of words) keywords.add(w);
    }

    return keywords;
  }

  // ─── ENHANCED: Render table block with sample values ──────────────────────────
  static _renderTableBlock(entry, sampleValues = {}) {
    const { name, isView, columns, foreignKeys, jsonColumns } = entry;
    const typeLabel = isView ? 'VIEW' : 'TABLE';

    // Column lines with sample values
    const colLines = columns.map(c => {
      const tags = [];
      if (c.key === 'PRI') tags.push('PK');
      
      const isFk = foreignKeys.some(fk => fk.columnName === c.name);
      if (isFk) {
        const fk = foreignKeys.find(fk => fk.columnName === c.name);
        tags.push(`FK→${fk.refTable}.${fk.refColumn}`);
      }
      if (c.dataType === 'json') tags.push('JSON⚠️');
      
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
      
      // NEW: Add sample values if available
      const samples = sampleValues[c.name];
      const sampleStr = samples && samples.length > 0
        ? `\n    → Samples: ${samples.slice(0, 5).map(s => `"${s}"`).join(', ')}${samples.length > 5 ? '...' : ''}`
        : '';
      
      return `  ${c.name} (${c.dataType})${tagStr}${sampleStr}`;
    }).join('\n');

    const fkLines = foreignKeys.length
      ? foreignKeys.map(fk =>
          `  JOIN ${fk.refTable} ON ${name}.${fk.columnName} = ${fk.refTable}.${fk.refColumn}`
        ).join('\n')
      : null;

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
    rules.push('- Use exact sample values shown above when filtering.');

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

  // ─── Dynamic examples based on matched tables ─────────────────────────────────
  static _buildExamples(tables) {
    const EXAMPLE_MAP = {
      v_companies: `SELECT name, hq_country, financing_status, employees FROM v_companies WHERE hq_country = 'United States' ORDER BY employees DESC LIMIT 20`,
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
    this._catalog = null;
    schemaCache.clear();
    logger.info('Schema catalog cleared — will rebuild on next request');
  }

  static async getSchemaDescription() {
    await this._ensureCatalog();
    return `Catalog loaded: ${this._catalog.size} tables`;
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

// ─── Stop words ───────────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'this', 'that', 'have',
  'date', 'flag', 'link', 'url', 'type', 'name', 'note', 'notes',
  'status', 'count', 'size', 'list', 'data', 'info', 'page',
  'body', 'text', 'json', 'bool', 'int', 'char', 'long',
]);