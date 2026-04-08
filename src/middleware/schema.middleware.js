import { SchemaService } from '../services/schema.service.js';
import { getLLMClient, validateSchemaSize } from '../config/llm.js';
import { logger } from '../utils/logger.js';

export const validateSchemaForModel = async (req, res, next) => {
  try {
    const schema = await SchemaService.getSchemaDescription();
    const estimatedTokens = Math.ceil(schema.length / 4);
    
    const { model } = getLLMClient();
    const validation = validateSchemaSize(estimatedTokens, model);
    
    if (!validation.valid) {
      logger.error('Schema validation failed', {
        model,
        schemaTokens: estimatedTokens,
        error: validation.error
      });
      
      return res.status(400).json({
        error: 'Schema too large for selected model',
        details: validation.error,
        suggestion: 'Please use llama-3.3-70b-versatile, mixtral-8x7b-32768, or upgrade to a model with larger context'
      });
    }
    
    if (validation.warning) {
      logger.warn('Schema validation warning', {
        model,
        schemaTokens: estimatedTokens,
        warning: validation.warning
      });
    }
    
    req.schemaMetadata = {
      size: schema.length,
      estimatedTokens,
      model
    };
    
    next();
  } catch (error) {
    next(error);
  }
};