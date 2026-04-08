import { getLLMClient } from '../config/llm.js';
import { logger } from '../utils/logger.js';
import { SchemaService } from './schema.service.js';


export class LLMService {
  static buildPrompt(question, schema) {
    // OPTIMIZED: Minimal, focused prompt
    return `You are a MySQL query generator for a longevity/biotech database.

${schema}

Question: ${question}

**IMPORTANT INSTRUCTIONS:**

1. Check the COLUMN NAME MAPPINGS table carefully - use EXACT column names
2. Only use GROUP BY when you need aggregation (COUNT, SUM, etc.)
3. For simple lists, just SELECT columns without GROUP BY
4. Always include LIMIT (max 50)
5. The word "grant" in strings/column names is OK - only SQL GRANT command is blocked

**Output JSON format:**
{
  "sql": "SELECT ... FROM ... WHERE ... LIMIT ...",
  "visualization_type": "table|bar_chart|pie_chart|line_chart|metric",
  "explanation": "What this shows",
  "chart_config": {
    "x_key": "column_name",
    "y_key": "column_name", 
    "title": "Chart title"
  }
}`;
  }

  // Keep all provider methods unchanged
  static async generateQueryWithAnthropic(question, schema, client, model) {
    const prompt = this.buildPrompt(question, schema);

    const response = await client.messages.create({
      model: model,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const content = response.content[0].text;
    return JSON.parse(content);
  }

  static async generateQueryWithOpenAI(question, schema, client, model) {
    const prompt = this.buildPrompt(question, schema);

    const response = await client.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: 'You are a MySQL query generator. Always respond with valid JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000
    });

    return JSON.parse(response.choices[0].message.content);
  }

  static async generateQueryWithGroq(question, schema, client, model) {
    const prompt = this.buildPrompt(question, schema);
    
    //logger.info('Question and schema:', { question: question.substring(), schema: schema.substring() });

    const response = await client.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: 'You are a MySQL query generator. Respond with valid JSON only, no markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 1500,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0].message.content;
    const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    return JSON.parse(cleanContent);
  }

  static async generateQuery(question) {
    try {
      const schema = await SchemaService.getSchemaDescription();
      const { client, type, model } = getLLMClient();

      const estimatedTokens = Math.ceil(schema.length / 4);
      logger.info(`Generating query with ${type}/${model}`, {
        schemaSize: schema.length,
        estimatedTokens,
        question: question.substring(0, 100)
      });

      let result;
      if (type === 'anthropic') {
        result = await this.generateQueryWithAnthropic(question, schema, client, model);
      } else if (type === 'openai') {
        result = await this.generateQueryWithOpenAI(question, schema, client, model);
      } else if (type === 'groq') {
        result = await this.generateQueryWithGroq(question, schema, client, model);
      }

      logger.info('Query generated successfully', {
        provider: type,
        sql: result.sql.substring(0, 100),
        visualization: result.visualization_type
      });

      return result;
    } catch (error) {
      logger.error('LLM generation error:', error);
      
      if (error.message?.includes('rate_limit_exceeded') || error.message?.includes('Request too large')) {
        logger.error('Token limit exceeded - schema too large');
        throw new Error('Schema too large for selected model. Please use llama-3.3-70b-versatile or gpt-4-turbo.');
      }
      
      throw new Error(`Failed to generate query: ${error.message}`);
    }
  }

  static async *generateQueryStreamWithAnthropic(question, schema, client, model) {
    const prompt = this.buildPrompt(question, schema);
    
    const stream = await client.messages.create({
      model: model,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
      stream: true
    });

    let fullContent = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullContent += event.delta.text;
        yield { type: 'content', data: event.delta.text };
      }
    }

    const result = JSON.parse(fullContent);
    yield { type: 'complete', data: result };
  }

  static async *generateQueryStreamWithOpenAI(question, schema, client, model) {
    const prompt = this.buildPrompt(question, schema);
    
    const stream = await client.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: 'You are a MySQL query generator. Always respond with valid JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      stream: true
    });

    let fullContent = '';
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullContent += content;
        yield { type: 'content', data: content };
      }
    }

    const result = JSON.parse(fullContent);
    yield { type: 'complete', data: result };
  }

  static async *generateQueryStreamWithGroq(question, schema, client, model) {
    const prompt = this.buildPrompt(question, schema);
    
    const stream = await client.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: 'You are a MySQL query generator. Respond with valid JSON only, no markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
      stream: true
    });

    let fullContent = '';
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullContent += content;
        yield { type: 'content', data: content };
      }
    }

    const cleanContent = fullContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(cleanContent);
    yield { type: 'complete', data: result };
  }

  static async *generateQueryStream(question) {
    try {
      const schema = await SchemaService.getSchemaDescription();
      const { client, type, model } = getLLMClient();

      logger.info('Starting streaming query generation', {
        provider: type,
        model,
        question: question.substring(0, 100)
      });

      if (type === 'anthropic') {
        yield* this.generateQueryStreamWithAnthropic(question, schema, client, model);
      } else if (type === 'openai') {
        yield* this.generateQueryStreamWithOpenAI(question, schema, client, model);
      } else if (type === 'groq') {
        yield* this.generateQueryStreamWithGroq(question, schema, client, model);
      }
    } catch (error) {
      logger.error('LLM streaming error:', error);
      yield { type: 'error', data: error.message };
    }
  }
}