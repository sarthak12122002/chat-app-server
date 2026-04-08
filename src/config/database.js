import knex from 'knex';
import knexConfig from '../../knexfile.js';
import { config } from './index.js';

const environment = config.env;
const connectionConfig = knexConfig[environment];

// PostgreSQL connection for application data
export const db = knex(connectionConfig);

// MySQL connection for biotech data
export const mysqlDb = knex({
  client: 'mysql2',
  connection: config.database.mysqlUrl,
  pool: { min: 2, max: 10 },
  // MySQL specific settings
  acquireConnectionTimeout: 10000,
});

// Test PostgreSQL connection
export const testPostgresConnection = async () => {
  try {
    await db.raw('SELECT 1+1 AS result');
    console.log('✓ PostgreSQL connection successful');
    return true;
  } catch (error) {
    console.error('✗ PostgreSQL connection failed:', error.message);
    return false;
  }
};

// Test MySQL connection
export const testMySQLConnection = async () => {
  try {
    await mysqlDb.raw('SELECT 1+1 AS result');
    console.log('✓ MySQL connection successful');
    return true;
  } catch (error) {
    console.error('✗ MySQL connection failed:', error.message);
    return false;
  }
};

// Test both connections
export const testConnections = async () => {
  const pgConnected = await testPostgresConnection();
  const mysqlConnected = await testMySQLConnection();
  
  return pgConnected && mysqlConnected;
};