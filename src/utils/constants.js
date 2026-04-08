export const BIOTECH_KEYWORDS = [
  // Companies & Industry
  'biotech', 'pharmaceutical', 'pharma', 'biopharma', 'company', 'companies',
  'amgen', 'regeneron', 'vertex', 'biogen', 'gilead', 'moderna', 'biontech',
  
  // Financial Terms
  'market cap', 'revenue', 'r&d', 'spending', 'financials', 'quarterly',
  'cash position', 'net income', 'market capitalization', 'valuation',
  
  // Drug Development
  'drug', 'therapy', 'treatment', 'pipeline', 'candidate', 'molecule',
  'clinical trial', 'phase 1', 'phase 2', 'phase 3', 'phase i', 'phase ii', 'phase iii',
  'fda', 'approval', 'approved', 'indication', 'therapeutic',
  
  // Science & Research
  'antibody', 'monoclonal', 'small molecule', 'gene therapy', 'cell therapy',
  'protein', 'enzyme', 'biologics', 'immunotherapy', 'oncology',
  
  // Diseases & Conditions
  'cancer', 'diabetes', 'alzheimer', 'parkinson', 'cardiovascular',
  'rare disease', 'orphan drug', 'autoimmune', 'infectious disease',
  
  // Business Metrics
  'enrollment', 'patients', 'trial', 'development stage', 'peak sales',
  'first-in-class', 'best-in-class', 'blockbuster'
];

export const REJECTION_MESSAGE = 
  "I can only answer questions about biotech industry data, including companies, " +
  "clinical trials, drug pipelines, FDA approvals, and financial metrics. " +
  "Please ask a question related to the biotechnology and pharmaceutical sector.";

export const VISUALIZATION_TYPES = {
  TABLE: 'table',
  BAR_CHART: 'bar_chart',
  PIE_CHART: 'pie_chart',
  LINE_CHART: 'line_chart',
  METRIC: 'metric'
};

export const QUERY_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  ERROR: 'error',
  REJECTED: 'rejected'
};