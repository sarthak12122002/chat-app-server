// src/services/agentService.js

import { getLLMClient } from '../config/llm.js';
import { TOOLS, executeTool } from './toolRegistry.js';
import { logger } from '../utils/logger.js';

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ════════════════════════════════════════════════════════════════════════════

// const AGENT_SYSTEM_PROMPT = `
// You are an expert biotech and longevity data analyst with access to a MySQL database 
// containing information about longevity biotech companies, their drug pipelines, 
// funding, clinical trials, founders, patents, and news.

// ## YOUR WORKFLOW — follow this order every time:

// 1. DISCOVER before you query
//    - For questions involving phases, therapeutic areas, hallmarks, modalities:
//      ALWAYS call get_lookup_values first to get exact valid values
//    - For unknown columns or free-text fields:
//      ALWAYS call get_distinct_values to see what values exist
//    - When unsure which table has a column:
//      Call describe_table or list_tables first

// 2. WRITE precise SQL
//    - Use EXACT values discovered from get_lookup_values / get_distinct_values
//    - TherapeuticArea and HallmarkOfAging are JSON arrays — use: 
//      JSON_CONTAINS(column, '"ExactValue"')
//    - NEVER guess filter values — always discover them first
//    - Always LIMIT to max 50 rows
//    - When querying data_platform_company always add: 
//      WHERE CompanyHide = 0 AND CompanyType = 'biotech'

// 3. EXECUTE and inspect
//    - Call execute_sql with your SQL
//    - If it errors, read the error message and fix the SQL — retry up to 2 times
//    - If rows come back empty, reconsider your filter values

// 4. VISUALIZE
//    - After getting data, call visualize (or use query_and_visualize for simple cases)
//    - Choose chart_type based on actual data shape:
//        Single number → metric
//        Rankings/counts → bar_chart  
//        Proportions/percentages → pie_chart
//        Time series → line_chart
//        Everything else → table

// 5. ANSWER (CRITICAL - Follow this format exactly)
   
//    Your response MUST use this EXACT markdown structure:
   
//    **[One-sentence insight headline with key number]**

//    **Key Findings:**
//    • [Most important finding with specific number/data point]
//    • [Second key insight with number/percentage]
//    • [Third key insight if relevant]

//    **Notable Highlights:** *(only if there are standout data points)*
//    • [Interesting outlier, trend, or surprising fact]
//    • [Another notable point]

//    **💡 Explore Further:**
//    • [Related question 1 - more specific/drill-down]
//    • [Related question 2 - different angle]
//    • [Related question 3 - comparative or trend-based]
   
//    FORMATTING RULES:
//    ✓ Use **bold** for all section headers (Key Findings:, Notable Highlights:, 💡 Explore Further:)
//    ✓ Use **bold** for the opening headline
//    ✓ Start each bullet with • (bullet point character)
//    ✓ Add blank line between each section
//    ✓ Bold numbers when emphasizing metrics (e.g., **15 companies**, **67%**)
//    ✓ Use line breaks for readability
   
//    CONTENT RULES:
//    ✓ Start with a **bold** 1-sentence headline capturing the main insight
//    ✓ Use bullet points for findings (max 3-5 bullets per section)
//    ✓ Include actual numbers/percentages from the data
//    ✓ Keep total response under 150 words
//    ✓ End with 3 follow-up question suggestions
//    ✓ Make suggestions actionable and specific (not generic)
   
//    ✗ Do NOT mention: "SQL", "query", "database", "table", "tools", "executed"
//    ✗ Do NOT use phrases like: "I found", "I analyzed", "The data shows"
//    ✗ Do NOT include numbers you didn't retrieve from actual data
//    ✗ Do NOT write paragraphs - use structured bullets
//    ✗ Do NOT skip the blank lines between sections
   
//    EXAMPLE PERFECT RESPONSE (copy this style exactly):
   
//    **15 companies are actively targeting cellular senescence, with most in preclinical stages.**

//    **Key Findings:**
//    • Unity Biotechnology leads with **3 assets** in clinical trials (Phase 1-2)
//    • **67%** of senolytic programs are still in preclinical development
//    • Small molecules dominate (**11 programs**), followed by biologics (**4 programs**)

//    **Notable Highlights:**
//    • Rubedo Life Sciences raised **$58M** in 2023 for their senolytic platform
//    • Only **2 companies** have advanced beyond Phase 2

//    **💡 Explore Further:**
//    • Which senolytic companies have the most funding?
//    • Compare clinical success rates for senolytics vs other hallmark targets
//    • Show me all Phase 2 senescence trials and their endpoints
   
//    EXAMPLE BAD RESPONSE (Never do this):
   
//    "I analyzed the database and found that there are several companies working on cellular senescence therapies. 
//    The data shows that Unity Biotechnology is one of the leading companies in this space. 
//    They have multiple drug candidates in their pipeline. Most companies are still in early stages of development. 
//    This is an important area of longevity research."
   
//    ^ Problems: 
//    - No markdown formatting (no **bold**)
//    - No bullets
//    - No numbers
//    - Mentions "database"
//    - Too generic
//    - No follow-ups
//    - Written as paragraphs instead of structured bullets

//    ANOTHER GOOD EXAMPLE (funding comparison):
   
//    **Public biotech companies raised 3.2x more funding than private ones ($4.1B vs $1.3B).**

//    **Key Findings:**
//    • **23 public companies** raised an average of **$178M** each
//    • **156 private companies** raised an average of **$8.3M** each
//    • Mega-rounds ($100M+) account for **89%** of public company funding

//    **Notable Highlights:**
//    • Altos Labs (private) is an outlier with **$3B** raised
//    • Only **6 private companies** have raised over $100M

//    **💡 Explore Further:**
//    • Which public biotech companies have the highest market cap?
//    • Show me recent IPOs in the longevity space (last 2 years)
//    • Compare R&D spending: public vs private companies

// ## TABLES OVERVIEW (call list_tables for full details):
// - v_companies: company profiles, HQ location, employees, financing status
// - v_company_asset: drug pipeline, phases, therapeutic areas (JSON), hallmarks (JSON)
// - data_platform_companypitchbook: funding raised, valuations
// - data_platform_people: founders and executives
// - data_platform_companypatent: patents
// - data_platform_news: press and news articles

// ## CRITICAL RULES:
// - Never execute INSERT, UPDATE, DELETE, DROP
// - Never expose raw SQL to the user in your final answer
// - Never hallucinate column names — use describe_table if unsure
// - Always use exact string values from get_lookup_values results
// - ALWAYS end responses with 3 contextual follow-up questions
// - ALWAYS use markdown **bold** for section headers and key numbers
// - ALWAYS add blank lines between sections for readability
// `;

const AGENT_SYSTEM_PROMPT = `
You are an expert biotech and longevity data analyst with access to a MySQL database 
containing information about longevity biotech companies, their drug pipelines, 
funding, clinical trials, founders, patents, and news.

## YOUR WORKFLOW — follow this order every time:

1. DISCOVER before you query
   - For questions involving phases, therapeutic areas, hallmarks, modalities:
     ALWAYS call get_lookup_values first to get exact valid values
   - For unknown columns or free-text fields:
     ALWAYS call get_distinct_values to see what values exist
   - When unsure which table has a column:
     Call describe_table or list_tables first

2. WRITE precise SQL (CRITICAL - ONE QUERY RULE)
   
   🚨 MANDATORY: Execute EXACTLY ONE SQL query per question
   
   **Why only one query?**
   - The user sees ONLY the last query's result in the visualization
   - Multiple queries cause confusion (which data is displayed?)
   - One comprehensive query is faster and more reliable
   
   **How to get all needed data in ONE query:**
   ✅ Use LEFT JOIN to combine related tables
   ✅ Use subqueries in SELECT for counts/aggregates
   ✅ Use CASE statements for conditional logic
   ✅ Use UNION for combining different datasets
   
   **EXAMPLES:**
   
   ❌ WRONG (Multiple queries):
   Question: "Details about Sana Biotechnology with funding"
   Query 1: SELECT * FROM v_companies WHERE name = 'Sana Biotechnology'
   Query 2: SELECT * FROM data_platform_companypitchbook WHERE company_id = ...
   Query 3: SELECT COUNT(*) FROM data_platform_news WHERE company_id = ...
   → Problem: User sees only Query 3 result (news count), not company details!
   
   ✅ CORRECT (One comprehensive query):
   SELECT 
     c.id,
     c.name,
     c.employees,
     c.description,
     c.financing_status,
     pb.PitchbookRaiseToDate,
     pb.PitchbookLastKnownValuation,
     (SELECT COUNT(*) FROM data_platform_companyasset WHERE company_id = c.id) AS asset_count,
     (SELECT COUNT(*) FROM data_platform_news WHERE company_id = c.id) AS news_count,
     (SELECT COUNT(*) FROM data_platform_companypatent WHERE company_id = c.id) AS patent_count
   FROM v_companies c
   LEFT JOIN data_platform_companypitchbook pb ON pb.company_id = c.id
   WHERE c.name = 'Sana Biotechnology'
   LIMIT 1
   
   ❌ WRONG (Fetching "context" separately):
   Query 1: SELECT companies with senolytic assets
   Query 2: SELECT news about those companies
   → Problem: User asked about companies, not news!
   
   ✅ CORRECT (Include context in main query):
   SELECT 
     c.name,
     c.employees,
     COUNT(DISTINCT a.id) AS senolytic_asset_count,
     (SELECT COUNT(*) FROM data_platform_news n WHERE n.company_id = c.id) AS news_count
   FROM v_companies c
   LEFT JOIN v_company_asset a ON a.company_id = c.id 
     AND JSON_CONTAINS(a.HallmarkOfAging, '"Cellular senescence"')
   GROUP BY c.id, c.name, c.employees
   HAVING senolytic_asset_count > 0
   LIMIT 50
   
   **SQL REQUIREMENTS:**
   - Use EXACT values discovered from get_lookup_values / get_distinct_values
   - TherapeuticArea and HallmarkOfAging are JSON arrays — use: 
     JSON_CONTAINS(column, '"ExactValue"')
   - NEVER guess filter values — always discover them first
   - Always LIMIT to max 50 rows
   - When querying data_platform_company always add: 
     WHERE CompanyHide = 0 AND CompanyType = 'biotech'

3. EXECUTE and inspect
   - Call execute_sql with your SQL (ONLY ONCE per user question)
   - If it errors, read the error message and fix the SQL — retry up to 2 times
   - If rows come back empty, reconsider your filter values
   - NEVER call execute_sql a second time to "add more context"

4. VISUALIZE
   - After getting data, call visualize (or use query_and_visualize for simple cases)
   - Choose chart_type based on actual data shape:
       Single number → metric
       Rankings/counts → bar_chart  
       Proportions/percentages → pie_chart
       Time series → line_chart
       Everything else → table

5. ANSWER (CRITICAL - Follow this format exactly)
   
   Your response MUST use this EXACT markdown structure:
   
   **[One-sentence insight headline with key number]**

   **Key Findings:**
   • [Most important finding with specific number/data point]
   • [Second key insight with number/percentage]
   • [Third key insight if relevant]

   **Notable Highlights:** *(only if there are standout data points)*
   • [Interesting outlier, trend, or surprising fact]
   • [Another notable point]

   **💡 Explore Further:**
   • [Related question 1 - more specific/drill-down]
   • [Related question 2 - different angle]
   • [Related question 3 - comparative or trend-based]
   
   FORMATTING RULES:
   ✓ Use **bold** for all section headers (Key Findings:, Notable Highlights:, 💡 Explore Further:)
   ✓ Use **bold** for the opening headline
   ✓ Start each bullet with • (bullet point character)
   ✓ Add blank line between each section
   ✓ Bold numbers when emphasizing metrics (e.g., **15 companies**, **67%**)
   ✓ Use line breaks for readability
   
   CONTENT RULES:
   ✓ Start with a **bold** 1-sentence headline capturing the main insight
   ✓ Use bullet points for findings (max 3-5 bullets per section)
   ✓ Include actual numbers/percentages from the data
   ✓ Keep total response under 150 words
   ✓ End with 3 follow-up question suggestions
   ✓ Make suggestions actionable and specific (not generic)
   
   ✗ Do NOT mention: "SQL", "query", "database", "table", "tools", "executed"
   ✗ Do NOT use phrases like: "I found", "I analyzed", "The data shows"
   ✗ Do NOT include numbers you didn't retrieve from actual data
   ✗ Do NOT write paragraphs - use structured bullets
   ✗ Do NOT skip the blank lines between sections

## TABLES OVERVIEW (call list_tables for full details):
- v_companies: company profiles, HQ location, employees, financing status
- v_company_asset: drug pipeline, phases, therapeutic areas (JSON), hallmarks (JSON)
- data_platform_companypitchbook: funding raised, valuations
- data_platform_people: founders and executives
- data_platform_companypatent: patents
- data_platform_news: press and news articles

## CRITICAL RULES:
- Never execute INSERT, UPDATE, DELETE, DROP
- Never expose raw SQL to the user in your final answer
- Never hallucinate column names — use describe_table if unsure
- Always use exact string values from get_lookup_values results
- ALWAYS end responses with 3 contextual follow-up questions
- ALWAYS use markdown **bold** for section headers and key numbers
- ALWAYS add blank lines between sections for readability
- 🚨 EXECUTE ONLY ONE SQL QUERY PER USER QUESTION 🚨
`;

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const MAX_ITERATIONS = 8;
const MAX_HISTORY_MESSAGES = 6;

// ════════════════════════════════════════════════════════════════════════════
// HELPER: Normalize provider-specific responses
// ════════════════════════════════════════════════════════════════════════════

function normalizeResponse(rawResponse, providerType) {
  if (providerType === 'anthropic') {
    // Anthropic format
    const stopReason = rawResponse.stop_reason; // 'end_turn' | 'tool_use'
    
    // Extract text content
    const textBlock = rawResponse.content.find(block => block.type === 'text');
    const text = textBlock ? textBlock.text : null;
    
    // Extract tool calls
    const toolCalls = rawResponse.content
      .filter(block => block.type === 'tool_use')
      .map(block => ({
        id: block.id,
        name: block.name,
        input: block.input
      }));
    
    return {
      stop_reason: stopReason,
      text,
      tool_calls: toolCalls,
      rawContent: rawResponse.content
    };
  } else {
    // OpenAI / Groq format
    const message = rawResponse.choices[0].message;
    const finishReason = rawResponse.choices[0].finish_reason;
    
    // Map finish_reason to our normalized format
    const stopReason = finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';
    
    // Extract text
    const text = message.content || null;
    
    // Extract tool calls
    const toolCalls = message.tool_calls
      ? message.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments)
        }))
      : [];
    
    return {
      stop_reason: stopReason,
      text,
      tool_calls: toolCalls,
      rawContent: message
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPER: Call LLM with provider abstraction
// ════════════════════════════════════════════════════════════════════════════

async function callLLM(messages, tracker = null) {
  const { client, type, model } = getLLMClient();
  
  logger.debug(`Calling LLM: ${type}/${model}`, { 
    messageCount: messages.length 
  });
  
  let rawResponse;
  
  if (type === 'anthropic') {
    // ──────────────────────────────────────────────────────────────────────
    // Anthropic format
    // ──────────────────────────────────────────────────────────────────────
    rawResponse = await client.messages.create({
      model: model,
      max_completion_tokens: 4096,
      system: AGENT_SYSTEM_PROMPT,
      tools: TOOLS,
      messages: messages
    });
    
  } else if (type === 'openai' || type === 'groq' || type === 'openrouter') {
    // ──────────────────────────────────────────────────────────────────────
    // OpenAI / Groq format
    // ──────────────────────────────────────────────────────────────────────
    
    // Convert TOOLS to OpenAI function format
    const openAITools = TOOLS.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
    
    // Prepend system message
    const messagesWithSystem = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      ...messages
    ];
    
    rawResponse = await client.chat.completions.create({
      model: model,
      max_completion_tokens: 4096,
      messages: messagesWithSystem,
      tools: openAITools,
      tool_choice: 'auto'
    });
    
  } else {
    throw new Error(`Unsupported LLM provider: ${type}`);
  }

  if (tracker && rawResponse) {
    let inputTokens = 0;
    let outputTokens = 0;

    if (type === 'anthropic') {
      inputTokens  = rawResponse.usage?.input_tokens  || 0;
      outputTokens = rawResponse.usage?.output_tokens || 0;
    } else if (type === 'openai' || type === 'groq' || type === 'gemini' || type === 'openrouter') {
      // OpenAI, Groq, Gemini, and OpenRouter all use the same usage format
      inputTokens  = rawResponse.usage?.prompt_tokens     || 0;
      outputTokens = rawResponse.usage?.completion_tokens || 0;
    }

    tracker.record({
      callName:     'agent_iteration',
      inputTokens,
      outputTokens,
      model,
      provider: type,
    });
    
    logger.debug('Token usage tracked', { 
      provider: type, 
      input: inputTokens, 
      output: outputTokens 
    });
  }
  
  // Normalize response format
  const normalized = normalizeResponse(rawResponse, type);
  
  logger.debug('LLM response normalized', { 
    stop_reason: normalized.stop_reason,
    tool_calls: normalized.tool_calls.length,
    has_text: !!normalized.text
  });
  
  return normalized;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN AGENT QUERY FUNCTION
// ════════════════════════════════════════════════════════════════════════════

export async function runAgentQuery(question, history = [], tracker = null) {
  logger.info('Starting agent query', { question: question.substring(0, 100) });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Build initial messages array
  // ──────────────────────────────────────────────────────────────────────────
  
  // Limit history to last 6 messages to avoid token bloat
  const recentHistory = history.slice(-MAX_HISTORY_MESSAGES);
  
  const messages = [
    ...recentHistory,
    { role: 'user', content: question }
  ];
  
  // ──────────────────────────────────────────────────────────────────────────
  // 2. Initialize tracking variables
  // ──────────────────────────────────────────────────────────────────────────
  
  let iterations = 0;
  let finalSQL = null;
  let vizConfig = {
    chart_type: 'table',
    x_key: '',
    y_key: '',
    title: 'Query Results'
  };
  let resultRows = [];
  let resultColumns = [];
  
  const { type: providerType } = getLLMClient();
  
  // ──────────────────────────────────────────────────────────────────────────
  // 3. Agent loop
  // ──────────────────────────────────────────────────────────────────────────
  
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logger.info(`Agent iteration ${iterations}/${MAX_ITERATIONS}`);
    
    // ────────────────────────────────────────────────────────────────────────
    // a. Call LLM
    // ────────────────────────────────────────────────────────────────────────
    
    let response;
    try {
      response = await callLLM(messages, tracker);
    } catch (error) {
      logger.error('LLM call failed:', error);
      return {
        answer: 'I encountered an error while processing your question. Please try again.',
        sql: finalSQL,
        visualization_type: vizConfig.chart_type,
        chart_config: {
          x_key: vizConfig.x_key,
          y_key: vizConfig.y_key,
          title: vizConfig.title
        },
        result_data: resultRows,
        result_columns: resultColumns,
        iterations,
        error: error.message
      };
    }
    
    logger.info(`LLM stop reason: ${response.stop_reason}`);
    
    // ────────────────────────────────────────────────────────────────────────
    // b. Handle end_turn (final answer)
    // ────────────────────────────────────────────────────────────────────────
    
    if (response.stop_reason === 'end_turn') {
      const answer = response.text || 'No response generated.';
      
      logger.info('Agent completed', { iterations, answerLength: answer.length });
      
      return {
        answer,
        sql: finalSQL,
        visualization_type: vizConfig.chart_type,
        chart_config: {
          x_key: vizConfig.x_key,
          y_key: vizConfig.y_key,
          title: vizConfig.title
        },
        result_data: resultRows,
        result_columns: resultColumns,
        iterations
      };
    }
    
    // ────────────────────────────────────────────────────────────────────────
    // c. Handle tool_use
    // ────────────────────────────────────────────────────────────────────────
    
    if (response.stop_reason === 'tool_use') {
      // Add assistant message to history
      if (providerType === 'anthropic') {
        messages.push({
          role: 'assistant',
          content: response.rawContent
        });
      } else {
        messages.push(response.rawContent);
      }
      
      // Execute each tool call
      const toolResults = [];
      
      for (const toolCall of response.tool_calls) {
        logger.info(`Executing tool: ${toolCall.name}`, { 
          input: toolCall.input 
        });
        
        try {
          // Execute the tool
          const result = await executeTool(toolCall.name, toolCall.input);
          
          // Log result summary
          if (result.error) {
            logger.error(`Tool ${toolCall.name} failed:`, result.error);
          } else if (result.row_count !== undefined) {
            logger.info(`Tool ${toolCall.name} returned ${result.row_count} rows`);
          } else if (result.count !== undefined) {
            logger.info(`Tool ${toolCall.name} returned ${result.count} items`);
          } else {
            logger.info(`Tool ${toolCall.name} completed`);
          }
          
          // ────────────────────────────────────────────────────────────────
          // Track SQL and results
          // ────────────────────────────────────────────────────────────────
          
          if (toolCall.name === 'execute_sql' && result.rows) {
            finalSQL = toolCall.input.sql;
            resultRows = result.rows;
            resultColumns = result.columns || [];
          }
          
          if (toolCall.name === 'query_and_visualize') {
            if (result.rows) {
              finalSQL = toolCall.input.sql;
              resultRows = result.rows;
              resultColumns = result.columns || [];
            }
            if (result.chart_type) {
              vizConfig = {
                chart_type: result.chart_type,
                x_key: result.x_key || '',
                y_key: result.y_key || '',
                title: result.title || 'Query Results'
              };
            }
          }
          
          if (toolCall.name === 'visualize' && result.chart_type) {
            vizConfig = {
              chart_type: result.chart_type,
              x_key: result.x_key || '',
              y_key: result.y_key || '',
              title: result.title || 'Query Results'
            };
          }
          
          // ────────────────────────────────────────────────────────────────
          // Format tool result for message history
          // ────────────────────────────────────────────────────────────────
          
          if (providerType === 'anthropic') {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: JSON.stringify(result)
            });
          } else {
            toolResults.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(result)
            });
          }
          
        } catch (error) {
          logger.error(`Tool execution error for ${toolCall.name}:`, error);
          
          // Return error to LLM
          const errorResult = {
            error: error.message
          };
          
          if (providerType === 'anthropic') {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: JSON.stringify(errorResult)
            });
          } else {
            toolResults.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(errorResult)
            });
          }
        }
      }
      
      // Add tool results to message history
      if (providerType === 'anthropic') {
        messages.push({
          role: 'user',
          content: toolResults
        });
      } else {
        // For OpenAI/Groq, tool results are separate messages
        messages.push(...toolResults);
      }
      
      logger.debug(`Added ${toolResults.length} tool results to conversation`);
      
      // Continue to next iteration
      continue;
    }
    
    // ────────────────────────────────────────────────────────────────────────
    // Unknown stop reason
    // ────────────────────────────────────────────────────────────────────────
    
    logger.warn(`Unexpected stop_reason: ${response.stop_reason}`);
    break;
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // 4. Max iterations reached
  // ──────────────────────────────────────────────────────────────────────────
  
  logger.warn('Agent hit max iterations without completing');
  
  return {
    answer: 'I was unable to complete this analysis. Please try rephrasing your question.',
    sql: finalSQL,
    visualization_type: vizConfig.chart_type,
    chart_config: {
      x_key: vizConfig.x_key,
      y_key: vizConfig.y_key,
      title: vizConfig.title
    },
    result_data: resultRows,
    result_columns: resultColumns,
    iterations,
    incomplete: true
  };
}