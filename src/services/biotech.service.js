import { BIOTECH_KEYWORDS, REJECTION_MESSAGE } from '../utils/constants.js';

export class BiotechService {
  static isBiotechRelated(question) {
    const lowerQuestion = question.toLowerCase();
    return BIOTECH_KEYWORDS.some(keyword => 
      lowerQuestion.includes(keyword.toLowerCase())
    );
  }

  static getRejectionResponse() {
    return {
      status: 'rejected',
      response_text: REJECTION_MESSAGE,
      visualization_type: null,
      result_data: null,
      generated_sql: null,
      chart_config: null
    };
  }

  static getSuggestedQueries() {
    return [
      "Show me the top 5 biotech companies by market cap",
      "How many clinical trials are in each phase?",
      "What is the total R&D spending across all companies?",
      "Which therapeutic areas have the most pipeline drugs?",
      "Which companies are publicly listed vs. privately held?",
      "Show me all active Phase 3 clinical trials",
      "What's the distribution of molecule types in the pipeline?",
      "What assets target mitochondrial dysfunction in biotech?"
    ];
  }
}