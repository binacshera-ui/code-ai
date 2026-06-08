export interface GeminiConversationSummary {
  id: string;
  title: string;
  stage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  lastModel: string | null;
  lastProvider: string | null;
  lastQuestionPreview: string;
  lastResponsePreview: string;
  messageCount: number;
  totalTokens: number | null;
  hasFiles: boolean;
  hasToolCalls: boolean;
  historyOffloaded: boolean;
  hasPublishedResponse: boolean;
  latestJobStatus: string | null;
  latestJobId: string | null;
  latestJobUpdatedAt: string | null;
}

export interface GeminiArtifact {
  filename?: string;
  originalFilename?: string;
  storedFilename?: string;
  mimeType?: string;
  gcsPath?: string;
  gsUri?: string;
  fileUri?: string;
  rawUrl?: string;
  uploadedAt?: string;
  [key: string]: unknown;
}

export interface GeminiUsageInfo {
  provider?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  [key: string]: unknown;
}

export interface GeminiConversationMessage {
  id: string;
  role: string;
  text: string;
  createdAt: string | null;
  files: GeminiArtifact[];
  meta: {
    model?: string | null;
    responseId?: string | null;
    finishReason?: string | null;
    usage?: GeminiUsageInfo | null;
    providerMetadata?: Record<string, unknown> | null;
    toolResponses?: Array<Record<string, unknown>> | null;
    requestDebug?: unknown | null;
    [key: string]: unknown;
  } | null;
}

export interface GeminiJobRecord {
  jobId: string;
  conversationId: string | null;
  status: string | null;
  enqueuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  durationMs: number | null;
  error: string | null;
  resultSnippet: string | null;
  taskName: string | null;
  model: string | null;
  provider: string | null;
  wait: boolean;
  timeoutRescueEnabled: boolean;
  rescueTriggered: boolean;
  questionPreview: string | null;
  userMessageId: string | null;
  totalTokens: number | null;
  publishedUrl: string | null;
}

export interface GeminiConversationDetailResponse {
  conversation: GeminiConversationSummary;
  messages: GeminiConversationMessage[];
  metadata: Record<string, unknown>;
  allFiles: GeminiArtifact[];
  lastTurnFiles: GeminiArtifact[];
  jobs: GeminiJobRecord[];
  rawConversation: Record<string, unknown>;
}

export interface GeminiJobDetailResponse {
  job: GeminiJobRecord;
  rawJob: Record<string, unknown>;
  conversation: GeminiConversationDetailResponse | null;
}

export interface GeminiConversationsListResponse {
  items: GeminiConversationSummary[];
  nextCursor: string | null;
  totalCount: number;
  stats: {
    totalConversations: number;
    activeJobs: number;
    errorConversations: number;
    archivedConversations: number;
  };
}

export interface GeminiJobsListResponse {
  items: GeminiJobRecord[];
  nextCursor: string | null;
  totalCount: number;
}

export interface GeminiExportResult {
  conversation_id: string;
  txt_file?: {
    url: string;
    base64: string;
  };
  html_file?: {
    url: string;
    base64: string;
  };
}

export interface GeminiExportResponse {
  mode: 'zip' | 'individual';
  url?: string;
  filename?: string;
  base64?: string;
  count?: number;
  results?: GeminiExportResult[];
}
