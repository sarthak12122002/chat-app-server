import dotenv from 'dotenv';
dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3001,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  
  database: {
    // PostgreSQL for application data
    postgresUrl: process.env.DATABASE_URL,
    
    // MySQL for biotech data
    mysqlUrl: process.env.MYSQL_URL
  },
  
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },
  
  llm: {
    provider: process.env.LLM_PROVIDER || 'groq',
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022'
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview'
    },
     groq: {
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
    },
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free',
    }
  },

   // NEW: Schema Configuration
  schema: {
    cacheDurationMinutes: parseInt(process.env.SCHEMA_CACHE_DURATION, 10) || 60,
    includeSystemTables: process.env.INCLUDE_SYSTEM_TABLES === 'true' || false,
    maxSampleRows: parseInt(process.env.SCHEMA_SAMPLE_ROWS, 10) || 3,
    priorityTables: (process.env.PRIORITY_TABLES || '').split(',').filter(Boolean),
    excludeTables: (process.env.EXCLUDE_TABLES || '').split(',').filter(Boolean)
  },
  
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 20
  },
  
  sql: {
    maxResultRows: parseInt(process.env.MAX_SQL_RESULT_ROWS, 10) || 500,
    timeoutMs: parseInt(process.env.SQL_TIMEOUT_MS, 10) || 10000
  },
  
  logging: {
    level: process.env.LOG_LEVEL || 'info'
  }
};