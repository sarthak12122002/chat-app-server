/**
 * Migration: Add Chat Sessions
 * 
 * Creates:
 * 1. chat_sessions table - Groups related queries into conversations
 * 2. Adds session_id and deleted_at to chat_queries table
 * 3. Creates v_chat_sessions view for statistics
 * 
 * Dependencies:
 * - Requires users table (optional FK)
 * - Requires chat_queries table
 * 
 * FIXED: Reordered operations to add deleted_at BEFORE creating view
 */

export const up = async (knex) => {
  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1: Add soft delete to chat_queries FIRST
  // WHY: The view needs this column to exist
  // CHANGE: Moved from step 4 to step 1
  // ─────────────────────────────────────────────────────────────────────────
  const hasDeletedAt = await knex.schema.hasColumn('chat_queries', 'deleted_at');
  
  if (!hasDeletedAt) {
    await knex.schema.table('chat_queries', (table) => {
      table.timestamp('deleted_at')
        .nullable()
        .comment('Soft delete timestamp');
      
      table.index('deleted_at');
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2: Create chat_sessions table
  // WHY: Group related queries into conversation threads
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('chat_sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    
    // Link to users (optional - nullable for anonymous sessions)
    table.uuid('user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL')
      .comment('User who owns this session (optional)');
    
    // Session metadata
    table.string('title', 255)
      .notNullable()
      .comment('Session title (usually first question)');
    
    // Timestamps
    table.timestamp('created_at')
      .notNullable()
      .defaultTo(knex.fn.now());
    
    table.timestamp('updated_at')
      .notNullable()
      .defaultTo(knex.fn.now());
    
    table.timestamp('deleted_at')
      .nullable()
      .comment('Soft delete timestamp');
    
    // Indexes
    table.index('user_id');
    table.index('created_at');
    table.index('deleted_at');
    table.index('updated_at');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3: Add session_id to chat_queries table
  // WHY: Link queries to their conversation session
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.table('chat_queries', (table) => {
    table.uuid('session_id')
      .nullable()
      .references('id')
      .inTable('chat_sessions')
      .onDelete('SET NULL')
      .comment('Link to conversation session');
    
    table.index('session_id');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 4: Create view for session statistics
  // WHY: Quick access to session metadata with query counts
  // CHANGE: Now runs AFTER deleted_at column exists
  // ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW v_chat_sessions AS
    SELECT 
      s.id,
      s.user_id,
      s.title,
      s.created_at,
      s.updated_at,
      COUNT(q.id) AS query_count,
      MAX(q.created_date) AS last_query_at
    FROM chat_sessions s
    LEFT JOIN chat_queries q 
      ON s.id = q.session_id 
      AND q.deleted_at IS NULL
    WHERE s.deleted_at IS NULL
    GROUP BY s.id, s.user_id, s.title, s.created_at, s.updated_at
    ORDER BY s.updated_at DESC
  `);
};

export const down = async (knex) => {
  // ─────────────────────────────────────────────────────────────────────────
  // Rollback: Remove in reverse order
  // ─────────────────────────────────────────────────────────────────────────
  
  // 1. Drop view first
  await knex.raw('DROP VIEW IF EXISTS v_chat_sessions');
  
  // 2. Remove session_id column from chat_queries
  await knex.schema.table('chat_queries', (table) => {
    table.dropForeign('session_id');
    table.dropColumn('session_id');
  });
  
  // 3. Drop chat_sessions table
  await knex.schema.dropTableIfExists('chat_sessions');
  
  // 4. Remove deleted_at from chat_queries
  // NOTE: Uncomment if you want rollback to remove this column
  const hasDeletedAt = await knex.schema.hasColumn('chat_queries', 'deleted_at');
  if (hasDeletedAt) {
    await knex.schema.table('chat_queries', (table) => {
      table.dropColumn('deleted_at');
    });
  }
};