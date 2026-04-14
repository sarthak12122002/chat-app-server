// src/utils/tokenTracker.js

export class TokenTracker {
  constructor() {
    this.calls = [];       // individual LLM call records
    this.startTime = Date.now();
  }

  // Call this after EVERY LLM response
  record({ callName, inputTokens, outputTokens, model, provider }) {
    this.calls.push({
      call_name:     callName,       // e.g. 'classify', 'agent_iter_1'
      input_tokens:  inputTokens  || 0,
      output_tokens: outputTokens || 0,
      total_tokens:  (inputTokens || 0) + (outputTokens || 0),
      model,
      provider,
      timestamp:     Date.now(),
    });
  }

  // Normalize raw LLM response → { inputTokens, outputTokens }
  // Works for Anthropic, OpenAI, and Groq
  static extractTokens(rawResponse, providerType) {
    try {
      if (providerType === 'anthropic') {
        return {
          inputTokens:  rawResponse.usage?.input_tokens  || 0,
          outputTokens: rawResponse.usage?.output_tokens || 0,
        };
      }

      if (providerType === 'openai' || providerType === 'groq') {
        return {
          inputTokens:  rawResponse.usage?.prompt_tokens     || 0,
          outputTokens: rawResponse.usage?.completion_tokens || 0,
        };
      }
    } catch (_) {}

    return { inputTokens: 0, outputTokens: 0 };
  }

  // Summary across all calls in this request
  summary() {
    const totalInput    = this.calls.reduce((s, c) => s + c.input_tokens,  0);
    const totalOutput   = this.calls.reduce((s, c) => s + c.output_tokens, 0);
    const totalTokens   = totalInput + totalOutput;
    const totalCalls    = this.calls.length;
    const durationMs    = Date.now() - this.startTime;

    // Cost estimates (update rates as needed)
    const COST_PER_1K = {
      // Anthropic
      'claude-opus-4-5':         { input: 0.015,  output: 0.075  },
      'claude-sonnet-4-5':       { input: 0.003,  output: 0.015  },
      'claude-haiku-4-5':        { input: 0.00025,output: 0.00125},
      // OpenAI
      'gpt-4o':                  { input: 0.005,  output: 0.015  },
      'gpt-4o-mini':             { input: 0.00015,output: 0.0006 },
      // Groq (free tier / very cheap)
      'llama-3.3-70b-versatile': { input: 0.00059,output: 0.00079},
    };

    // Calculate cost per call
    const callsWithCost = this.calls.map(c => {
      const rates = COST_PER_1K[c.model] || { input: 0, output: 0 };
      const cost  = (c.input_tokens / 1000 * rates.input) + 
                    (c.output_tokens / 1000 * rates.output);
      return { ...c, estimated_cost_usd: parseFloat(cost.toFixed(6)) };
    });

    const totalCost = callsWithCost.reduce(
      (s, c) => s + c.estimated_cost_usd, 0
    );

    return {
      total_input_tokens:    totalInput,
      total_output_tokens:   totalOutput,
      total_tokens:          totalTokens,
      total_llm_calls:       totalCalls,
      estimated_cost_usd:    parseFloat(totalCost.toFixed(6)),
      duration_ms:           durationMs,
      calls:                 callsWithCost,  // per-call breakdown
    };
  }
}