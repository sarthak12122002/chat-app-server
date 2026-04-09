import { BiotechService } from '../services/biotech.service.js';
import { LLMService } from '../services/llm.service.js';
import { SQLService } from '../services/sql.service.js';
import { QueryService } from '../services/query.service.js';
import { QUERY_STATUS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

export class ChatController {
  static async processQuery(req, res, next) {
    try {
      const { question } = req.validatedData;
      const userId = req.user?.id || null;

      // ─────────────────────────────────────────────────────────────────────
      // CHANGE: AI-powered intent classification (replaces keyword matching)
      // WHY: Handles greetings, spelling errors, and context better than keywords
      // ─────────────────────────────────────────────────────────────────────
      const classification = await BiotechService.classifyQuestion(question);

      // Handle greetings/casual conversation
      if (classification.category === 'greeting') {
        const greetingResponse = BiotechService.getGreetingResponse(question);
        
        const saved = await QueryService.create({
          question,
          user_id: userId,
          status: QUERY_STATUS.COMPLETED,
          response_text: greetingResponse
        });

        return res.json({
          status: QUERY_STATUS.COMPLETED,
          query_id: saved.id,
          response_text: greetingResponse,
          suggestions: BiotechService.getSuggestedQueries(),
          visualization_type: null,
          result_data: null
        });
      }

      // Reject spam or completely unrelated queries
      if (classification.category === 'spam' || classification.category === 'general_knowledge') {
        const rejection = BiotechService.getRejectionResponse();
        
        const saved = await QueryService.create({
          question,
          user_id: userId,
          status: QUERY_STATUS.REJECTED,
          response_text: rejection.response_text
        });

        return res.json({
          ...rejection,
          query_id: saved.id,
          suggestions: BiotechService.getSuggestedQueries()
        });
      }

      // ─────────────────────────────────────────────────────────────────────
      // CHANGE: Use spell-corrected question if AI detected errors
      // WHY: Improves SQL generation accuracy (e.g., "senolytics" → "cellular senescence")
      // ─────────────────────────────────────────────────────────────────────
      const processedQuestion = classification.corrected_question || question;
      
      if (classification.corrected_question) {
        logger.info('Using spell-corrected question', {
          original: question,
          corrected: classification.corrected_question
        });
      }

      // Step 2: Generate SQL with LLM (using corrected question)
      let llmResult;
      try {
        llmResult = await LLMService.generateQuery(processedQuestion);
      } catch (error) {
        logger.error('LLM generation failed:', error);
        
        const saved = await QueryService.create({
          question,
          user_id: userId,
          status: QUERY_STATUS.ERROR,
          response_text: 'Failed to generate query. Please try rephrasing your question.'
        });

        return res.status(500).json({
          status: QUERY_STATUS.ERROR,
          query_id: saved.id,
          response_text: 'Failed to generate query. Please try rephrasing your question.',
          error_detail: error.message,
          suggestions: BiotechService.getSuggestedQueries()
        });
      }

      // Step 3: Execute SQL with auto-fix retry
      let rows;
      let finalSql = llmResult.sql;
      let autoFixed = false;

      try {
        rows = await SQLService.execute(finalSql);
      } catch (error) {
        logger.error('SQL execution failed, attempting auto-fix:', { 
          sql: llmResult.sql, 
          error: error.message 
        });
        
        // Try to auto-fix GROUP BY issues
        if (error.message.includes('GROUP BY')) {
          try {
            const fixedSql = SQLService.autoFixGroupBy(llmResult.sql);
            logger.info('Attempting auto-fixed SQL:', { fixedSql });
            
            rows = await SQLService.execute(fixedSql);
            finalSql = fixedSql;
            autoFixed = true;
            
            logger.info('Auto-fix successful');
          } catch (fixError) {
            logger.error('Auto-fix failed:', fixError);
            throw error; // Throw original error
          }
        } else {
          throw error;
        }
      }

      // If still failed, return error
      if (!rows) {
        const saved = await QueryService.create({
          question,
          user_id: userId,
          generated_sql: llmResult.sql,
          status: QUERY_STATUS.ERROR,
          response_text: 'Unable to execute the generated query. Please rephrase your question.'
        });

        return res.status(500).json({
          status: QUERY_STATUS.ERROR,
          query_id: saved.id,
          generated_sql: llmResult.sql,
          response_text: 'Unable to execute the generated query. Please rephrase your question.',
          error_detail: error.message,
          suggestions: BiotechService.getSuggestedQueries()
        });
      }

      // Step 4: Format results
      const resultData = SQLService.formatResultsForVisualization(
        rows,
        llmResult.visualization_type
      );

      // ─────────────────────────────────────────────────────────────────────
      // CHANGE: Include spell correction note in response if applicable
      // WHY: Transparency - user knows their input was auto-corrected
      // ─────────────────────────────────────────────────────────────────────
      let responseText = llmResult.explanation;
      if (autoFixed) {
        responseText += ' *(Query was automatically optimized)*';
      }

      // Step 5: Save to database
      const saved = await QueryService.create({
        question,
        user_id: userId,
        generated_sql: finalSql,
        response_text: responseText,
        visualization_type: llmResult.visualization_type,
        result_data: JSON.stringify(resultData),
        chart_config: JSON.stringify(llmResult.chart_config || {}),
        status: QUERY_STATUS.COMPLETED,
        is_saved: false
      });

      logger.info('Query processed successfully', {
        queryId: saved.id,
        question,
        corrected: classification.corrected_question,
        rowCount: rows.length,
        autoFixed
      });

      // Step 6: Return response
      res.json({
        status: QUERY_STATUS.COMPLETED,
        query_id: saved.id,
        generated_sql: finalSql,
        response_text: responseText,
        visualization_type: llmResult.visualization_type,
        result_data: resultData,
        chart_config: llmResult.chart_config || {},
        auto_fixed: autoFixed,
        spell_corrected: !!classification.corrected_question
      });

    } catch (error) {
      logger.error('Query processing error:', error);
      next(error);
    }
  }

  static async processQueryStream(req, res, next) {
    try {
      const { question } = req.validatedData;
      const userId = req.user?.id || null;

      // Set headers for SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Domain validation
      if (!BiotechService.isBiotechRelated(question)) {
        const rejection = BiotechService.getRejectionResponse();
        const saved = await QueryService.create({
          question,
          user_id: userId,
          status: QUERY_STATUS.REJECTED,
          response_text: rejection.response_text
        });

        res.write(`data: ${JSON.stringify({ ...rejection, query_id: saved.id })}\n\n`);
        res.end();
        return;
      }

      let llmResult;
      let fullContent = '';

      // Stream LLM response
      try {
        for await (const chunk of LLMService.generateQueryStream(question)) {
          if (chunk.type === 'content') {
            fullContent += chunk.data;
            res.write(`data: ${JSON.stringify({ type: 'llm_chunk', content: chunk.data })}\n\n`);
          } else if (chunk.type === 'complete') {
            llmResult = chunk.data;
            res.write(`data: ${JSON.stringify({ type: 'llm_complete', data: llmResult })}\n\n`);
          } else if (chunk.type === 'error') {
            throw new Error(chunk.data);
          }
        }
      } catch (error) {
        const saved = await QueryService.create({
          question,
          user_id: userId,
          status: QUERY_STATUS.ERROR,
          response_text: 'Failed to generate query.'
        });

        res.write(`data: ${JSON.stringify({ 
          type: 'error', 
          status: QUERY_STATUS.ERROR,
          query_id: saved.id,
          message: error.message 
        })}\n\n`);
        res.end();
        return;
      }

      // Execute SQL
      res.write(`data: ${JSON.stringify({ type: 'executing_sql' })}\n\n`);

      let rows;
      try {
        rows = await SQLService.execute(llmResult.sql);
      } catch (error) {
        const saved = await QueryService.create({
          question,
          user_id: userId,
          generated_sql: llmResult.sql,
          status: QUERY_STATUS.ERROR,
          response_text: 'Unable to execute query.'
        });

        res.write(`data: ${JSON.stringify({ 
          type: 'error',
          status: QUERY_STATUS.ERROR,
          query_id: saved.id,
          message: error.message 
        })}\n\n`);
        res.end();
        return;
      }

      const resultData = SQLService.formatResultsForVisualization(rows, llmResult.visualization_type);

      // Save to database
      const saved = await QueryService.create({
        question,
        user_id: userId,
        generated_sql: llmResult.sql,
        response_text: llmResult.explanation,
        visualization_type: llmResult.visualization_type,
        result_data: JSON.stringify(resultData),
        chart_config: JSON.stringify(llmResult.chart_config || {}),
        status: QUERY_STATUS.COMPLETED,
        is_saved: false
      });

      // Send final result
      res.write(`data: ${JSON.stringify({
        type: 'complete',
        status: QUERY_STATUS.COMPLETED,
        query_id: saved.id,
        generated_sql: llmResult.sql,
        response_text: llmResult.explanation,
        visualization_type: llmResult.visualization_type,
        result_data: resultData,
        chart_config: llmResult.chart_config || {}
      })}\n\n`);

      res.end();

    } catch (error) {
      logger.error('Stream processing error:', error);
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
      res.end();
    }
  }

  static async getSuggestedQueries(req, res, next) {
    try {
      const suggestions = BiotechService.getSuggestedQueries();
      res.json({ suggestions });
    } catch (error) {
      next(error);
    }
  }
}