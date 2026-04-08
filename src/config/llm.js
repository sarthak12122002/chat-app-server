import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import Groq from 'groq-sdk';
import { config } from './index.js';

// Model token limits
export const MODEL_LIMITS = {
  'llama-3.1-8b-instant': { maxTokens: 6000, recommended: 4000 },
  'llama-3.3-70b-versatile': { maxTokens: 32000, recommended: 20000 },
  'mixtral-8x7b-32768': { maxTokens: 32768, recommended: 25000 },
  'gemma2-9b-it': { maxTokens: 8192, recommended: 6000 },
  'gpt-4-turbo-preview': { maxTokens: 128000, recommended: 100000 },
  'claude-3-5-sonnet-20241022': { maxTokens: 200000, recommended: 150000 }
};

let anthropicClient = null;
let openaiClient = null;
let groqClient = null;

export const getAnthropicClient = () => {
  if (!anthropicClient && config.llm.anthropic.apiKey) {
    anthropicClient = new Anthropic({
      apiKey: config.llm.anthropic.apiKey
    });
  }
  return anthropicClient;
};

export const getOpenAIClient = () => {
  if (!openaiClient && config.llm.openai.apiKey) {
    openaiClient = new OpenAI({
      apiKey: config.llm.openai.apiKey
    });
  }
  return openaiClient;
};

export const getGroqClient = () => {
  if (!groqClient && config.llm.groq.apiKey) {
    groqClient = new Groq({
      apiKey: config.llm.groq.apiKey
    });
  }
  return groqClient;
};

export const getLLMClient = () => {
  const provider = config.llm.provider;
  
  if (provider === 'anthropic') {
    return {
      client: getAnthropicClient(),
      type: 'anthropic',
      model: config.llm.anthropic.model,
      limits: MODEL_LIMITS[config.llm.anthropic.model] || { maxTokens: 200000, recommended: 150000 }
    };
  } else if (provider === 'openai') {
    return {
      client: getOpenAIClient(),
      type: 'openai',
      model: config.llm.openai.model,
      limits: MODEL_LIMITS[config.llm.openai.model] || { maxTokens: 128000, recommended: 100000 }
    };
  } else if (provider === 'groq') {
    return {
      client: getGroqClient(),
      type: 'groq',
      model: config.llm.groq.model,
      limits: MODEL_LIMITS[config.llm.groq.model] || { maxTokens: 32000, recommended: 20000 }
    };
  }
  
  throw new Error(`Unsupported LLM provider: ${provider}`);
};

export const validateSchemaSize = (schemaTokens, model) => {
  const limits = MODEL_LIMITS[model];
  
  if (!limits) {
    return { valid: true, warning: null };
  }
  
  if (schemaTokens > limits.maxTokens) {
    return { 
      valid: false, 
      error: `Schema size (${schemaTokens} tokens) exceeds model limit (${limits.maxTokens} tokens)` 
    };
  }
  
  if (schemaTokens > limits.recommended) {
    return { 
      valid: true, 
      warning: `Schema size (${schemaTokens} tokens) is above recommended (${limits.recommended} tokens)` 
    };
  }
  
  return { valid: true, warning: null };
};