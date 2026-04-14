import { getLLMClient } from '../config/llm.js';
import { logger } from '../utils/logger.js';

/**
 * AI-powered biotech domain detection service
 * Replaces hardcoded keyword matching with intelligent intent classification
 */
export class BiotechService {
  
  /**
   * UPDATED: AI-powered domain detection with conversation history support
   * WHY: Allows follow-up questions without biotech keywords (e.g., "tell me about Unity Biotech")
   * CHANGE: Now accepts history parameter for context-aware classification
   * 
   * @param {string} question - Current user question
   * @param {Array} history - Previous conversation messages [{role, content}]
   * @returns {Object} Classification result
   */
  static async classifyQuestion(question, history = []) {
    try {
      const { client, type, model } = getLLMClient();

      // ─────────────────────────────────────────────────────────────────────
      // NEW: Build context from previous conversation
      // WHY: If user previously asked about biotech, assume follow-ups are related
      // ─────────────────────────────────────────────────────────────────────
      let conversationContext = '';
      
      if (history && history.length > 0) {
        // Take last 2 exchanges (4 messages) for context
        const recentHistory = history.slice(-4);
        
        conversationContext = `

      **CONVERSATION HISTORY:**
      ${recentHistory.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 150)}`).join('\n')}

      **IMPORTANT:** If the conversation history shows biotech-related discussion, classify follow-up questions as "biotech_query" even if they don't contain explicit biotech keywords.

      Examples:
      - After discussing "companies targeting cellular senescence", if user asks "tell me about Unity Biotechnology" → biotech_query
      - After showing "Phase 2 trials", if user asks "what about Phase 3?" → biotech_query
      - After any biotech discussion, questions like "show me more", "what about [company name]?" → biotech_query
      `;
            }
            
            // OPTIMIZATION: Use faster, cheaper model for classification (no schema needed)
            const classificationPrompt = `You are a conversational assistant that classifies user questions into categories.
      ${conversationContext}

      **CURRENT QUESTION:** "${question}"

      Classify this into ONE of these categories:
      1. "greeting" - Hello, hi, thanks, goodbye, how are you, casual conversation
      2. "biotech_query" - Questions about biotech/pharma companies, drugs, clinical trials, FDA approvals, diseases, therapeutics, longevity, aging, healthcare, OR follow-up questions in an ongoing biotech conversation
      3. "general_knowledge" - General questions about science, health, or non-biotech topics (NOT in biotech context)
      4. "spam" - Gibberish, unrelated topics, nonsense

      **CLASSIFICATION RULES:**
      - If conversation history exists and is biotech-related, assume current question is a follow-up (biotech_query)
      - Company names alone (e.g., "Unity Biotechnology", "Calico") should be biotech_query
      - Questions about specific drugs, trials, or therapies are biotech_query
      - Only reject if clearly unrelated AND no biotech context exists

      **SPELLING CORRECTION:**
      - If the question has typos or misspellings related to biotech terms, correct them
      - Examples: "senolytics" → "cellular senescence", "mTOR" → "mTOR pathway", "hallmarks of ageing" → "hallmarks of aging"

      Respond with JSON only:
      {
        "category": "greeting|biotech_query|general_knowledge|spam",
        "confidence": 0.0-1.0,
        "corrected_question": "spell-corrected version if needed, otherwise null",
        "reasoning": "brief explanation including context consideration"
      }`;

      let result;
      
      // PERFORMANCE: Quick classification without full schema
      if (type === 'anthropic') {
        const response = await client.messages.create({
          model: model,
          max_tokens: 400, // Slightly increased for context reasoning
          temperature: 0.2, // Low temp for consistent classification
          messages: [{ role: 'user', content: classificationPrompt }]
        });
        result = JSON.parse(response.content[0].text);
      } else if (type === 'openai') {
        const response = await client.chat.completions.create({
          model: model,
          messages: [
            { role: 'system', content: 'You are a question classifier. Respond with valid JSON only.' },
            { role: 'user', content: classificationPrompt }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_completion_tokens: 400
        });
        result = JSON.parse(response.choices[0].message.content);
      } else if (type === 'groq') {
        const response = await client.chat.completions.create({
          model: model,
          messages: [
            { role: 'system', content: 'You are a question classifier. Respond with valid JSON only.' },
            { role: 'user', content: classificationPrompt }
          ],
          temperature: 0.2,
          max_completion_tokens: 400,
          response_format: { type: 'json_object' }
        });
        const content = response.choices[0].message.content;
        result = JSON.parse(content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      }

      logger.info('Question classified', {
        question: question.substring(0, 50),
        category: result.category,
        confidence: result.confidence,
        corrected: result.corrected_question,
        had_history: history.length > 0
      });

      return result;
    } catch (error) {
      logger.error('Classification failed, falling back to simple check:', error);
      
      // ───────────────────────────────────────────────────────────────────────
      // UPDATED FALLBACK: If history exists, assume biotech follow-up
      // WHY: Better to allow follow-ups than block legitimate questions
      // ───────────────────────────────────────────────────────────────────────
      const lower = question.toLowerCase();
      const greetings = ['hello', 'hi', 'hey', 'thanks', 'thank you', 'bye', 'goodbye'];
      
      if (greetings.some(g => lower.includes(g))) {
        return {
          category: 'greeting',
          confidence: 0.9,
          corrected_question: null,
          reasoning: 'Fallback greeting detection'
        };
      }
      
      // If history exists, assume follow-up question
      if (history && history.length > 0) {
        return {
          category: 'biotech_query',
          confidence: 0.7,
          corrected_question: null,
          reasoning: 'Fallback - assuming follow-up in biotech conversation'
        };
      }
      
      // Default to biotech_query if AI fails (allow LLM to handle it)
      return {
        category: 'biotech_query',
        confidence: 0.5,
        corrected_question: null,
        reasoning: 'Fallback - assuming biotech related'
      };
    }
  }

  /**
   * NEW: Handle casual conversations with friendly responses
   * WHY: Better UX - chatbot should respond naturally to greetings
   */
  static getGreetingResponse(question) {
    const lower = question.toLowerCase();
    
    const responses = {
      hello: "Hello! I'm your biotech data assistant. I can help you explore pharmaceutical companies, clinical trials, drug pipelines, and longevity research. What would you like to know?",
      hi: "Hi there! 👋 I specialize in biotech and longevity data. Ask me about companies, drugs in development, clinical trials, or FDA approvals!",
      thanks: "You're welcome! Feel free to ask more questions about biotech, pharma, or longevity research anytime.",
      bye: "Goodbye! Come back anytime you need insights into biotech or longevity data. 👋"
    };

    // Match greeting type
    if (lower.includes('hello')) return responses.hello;
    if (lower.includes('hi') || lower.includes('hey')) return responses.hi;
    if (lower.includes('thank')) return responses.thanks;
    if (lower.includes('bye') || lower.includes('goodbye')) return responses.bye;

    // Default friendly response
    return "Hello! I'm here to help with biotech and longevity data. What would you like to explore?";
  }

  /**
   * UPDATED: Rejection message for non-biotech queries
   * WHY: More helpful - suggests what the bot CAN do
   */
  static getRejectionResponse() {
    return {
      status: 'rejected',
      response_text: "I specialize in biotech and longevity data. I can help you with:\n\n" +
        "• Companies: Market cap, funding, locations, pipelines\n" +
        "• Clinical Trials: Phases, FDA approvals, therapeutic areas\n" +
        "• Drug Development: Pipelines, modalities, mechanisms of action\n" +
        "• Longevity Research: Hallmarks of aging, senescence, healthspan\n\n" +
        "Try asking something like: \"Which companies are developing drugs for Alzheimer's?\" or \"Show me Phase 3 trials for cancer therapies.\"",
      visualization_type: null,
      result_data: null,
      generated_sql: null,
      chart_config: null
    };
  }

  /**
   * UPDATED: More contextual suggested queries
   */
  static getSuggestedQueries() {
    return [
      "Which hallmark of aging has the most therapeutic assets?",
      "Show me companies developing cellular senescence therapies",
      "List FDA-approved first-in-class drugs",
      "What assets are in Phase 3 clinical trials?",
      "Which companies raised over $500M in funding?",
      "Top biotech companies by pipeline size",
      "Show me all mTOR pathway inhibitors",
      "Companies targeting mitochondrial dysfunction"
    ];
  }
}