export const up = async (knex) => {
  await knex.schema.createTable('chat_queries', (table) => {
    table.increments('id').primary();
    table.uuid('user_id').references('id').inTable('users').onDelete('SET NULL');
    table.text('question').notNullable();
    table.text('generated_sql');
    table.text('response_text');
    table.string('visualization_type', 20).checkIn(['table', 'bar_chart', 'pie_chart', 'line_chart', 'metric']);
    table.text('result_data');
    table.text('chart_config');
    table.boolean('is_saved').notNullable().defaultTo(false);
    table.string('status', 20).notNullable().checkIn(['pending', 'completed', 'error', 'rejected']);
    table.timestamp('created_date').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('user_id');
    table.index('created_date');
    table.index('is_saved');
  });
};

export const down = async (knex) => {
  await knex.schema.dropTableIfExists('chat_queries');
};