// src/services/llm.service.js

import { getLLMClient } from '../config/llm.js';
import { logger } from '../utils/logger.js';
import { SchemaService } from './schema.service.js';
import { encode } from "gpt-tokenizer";
import { runAgentQuery } from './agentService.js';

// ════════════════════════════════════════════════════════════════════════════
// ENVIRONMENT VARIABLES:
// USE_AGENT_MODE=false   ← set to 'true' to enable agent mode
// ════════════════════════════════════════════════════════════════════════════

export class LLMService {
  static buildPrompt(question, schema) {
    // ─────────────────────────────────────────────────────────────────────
    // CHANGE: Added spelling correction instructions directly in SQL prompt
    // WHY: Double-layer correction - classification + SQL generation both fix errors
    // ─────────────────────────────────────────────────────────────────────
    return `You are a biotech/longevity data analyst. Generate a MySQL query for this question.

    ${schema}

    Question: ${question}

    INSTRUCTIONS:
    1. **AUTO-CORRECT SPELLINGS**: If question has typos in biotech terms, use correct spelling
      - Examples: "senolytics" → "Cellular Senescence", "mTOR" → "Deregulated Nutrient Sensing"
      - Use exact values from schema sample lists
    2. Use EXACT column names from schema above
    3. GROUP BY only with aggregates (COUNT, SUM, AVG, MAX, MIN)
    4. LIMIT max 50 rows
    5. Generate COMPLETE SQL, never truncate

    EXPLANATION RULES:
    - Explain what this question explores and why it's relevant in longevity/biotech
    - Do NOT include numbers/results (you don't have data yet)
    - Do NOT mention SQL, queries, or technical details
    - 2 sentences max: what + why it matters
    - Example: "This explores which hallmarks of aging have the most therapeutic focus, helping identify where drug development is concentrated."

    VISUALIZATION RULES:
    - Rankings/comparisons → bar_chart
    - Proportions → pie_chart  
    - Trends over time → line_chart
    - Single number → metric
    - Everything else → table

    Output valid JSON only (no markdown):
    {
      "sql": "COMPLETE SQL HERE",
      "visualization_type": "table|bar_chart|pie_chart|line_chart|metric",
      "explanation": "2 sentences about what this explores and why it matters",
      "chart_config": {
        "x_key": "exact_column_name",
        "y_key": "exact_column_name",
        "title": "Chart title"
      }
    }`;
  }

  // Keep all provider methods unchanged
  static async generateQueryWithAnthropic(question, schema, client, model) {
    const prompt = this.buildPrompt(question, schema);

    const response = await client.messages.create({
      model: model,
      max_completion_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const content = response.content[0].text;
    return JSON.parse(content);
  }

  static async generateQueryWithOpenAI(question, schema, client, model) {
    const prompt = this.buildPrompt(question, schema);

    const realTokens = encode(prompt).length;
    logger.info(`Real Token Size: ${realTokens}`);

    const response = await client.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: 'You are a MySQL query generator. Always respond with valid JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 2000
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
      max_completion_tokens: 2000,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0].message.content;
    const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    return JSON.parse(cleanContent);
  }

  static async generateQuery(question, history = []) {
    // ══════════════════════════════════════════════════════════════════════
    // ── Agent path (feature flagged) ──────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════
    if (process.env.USE_AGENT_MODE === 'true') {
      logger.info('Using agent mode for query generation');
      const agentResult = await runAgentQuery(question, history);
      
      // Normalize agent result to match existing llmResult shape
      // so nothing downstream in the controller needs to change
      return {
        sql:                agentResult.sql,
        visualization_type: agentResult.visualization_type,
        explanation:        agentResult.answer,
        chart_config:       agentResult.chart_config || { 
                              x_key: '', 
                              y_key: '', 
                              title: 'Query Results' 
                            },
        // Pass result_data through so controller can use it directly
        // instead of re-executing SQL (agent already ran it)
        _agentResultData:   agentResult.result_data,
        _agentResultColumns: agentResult.result_columns,
        _fromAgent:         true,
        _agentIterations:   agentResult.iterations
      };
    }
    // ══════════════════════════════════════════════════════════════════════
    // ── End agent path ────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════

    try {
      const schema = await SchemaService.getSchemaForQuestion(question);
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
      max_completion_tokens: 2000,
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
      max_completion_tokens: 1500,
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
      const schema = await SchemaService.getSchemaForQuestion(question);
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