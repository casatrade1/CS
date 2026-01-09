export type Intent = {
  id: string;
  title: string;
  answer: string;
  examples: string[];
  tags?: string[];
};

export type Suggestion = {
  intentId: string;
  title: string;
  answer: string;
  confidencePct: number;
  score: number;
  reason?: string;
  tags?: string[];
};


