import {
  GoogleGenerativeAI,
  GenerativeModel as GoogleGenerativeModel,
  type EnhancedGenerateContentResponse,
  type FunctionCall,
  type ModelParams as GoogleModelParams,
  type GenerateContentStreamResult as GoogleStreamGenerateContentResult,
} from "@google/generative-ai";

import { wrapLLMEvent } from "@llamaindex/core/decorator";
import type {
  CompletionResponse,
  LLMCompletionParamsNonStreaming,
  LLMCompletionParamsStreaming,
  LLMMetadata,
  ToolCall,
  ToolCallLLMMessageOptions,
} from "@llamaindex/core/llms";
import { ToolCallLLM } from "@llamaindex/core/llms";
import { streamConverter } from "@llamaindex/core/utils";
import { getEnv, randomUUID } from "@llamaindex/env";
import {
  GEMINI_BACKENDS,
  GEMINI_MODEL,
  type GeminiAdditionalChatOptions,
  type GeminiChatNonStreamResponse,
  type GeminiChatParamsNonStreaming,
  type GeminiChatParamsStreaming,
  type GeminiChatStreamResponse,
  type GeminiMessageRole,
  type GeminiModelInfo,
  type GeminiSessionOptions,
  type GoogleGeminiSessionOptions,
  type IGeminiSession,
} from "./types.js";
import {
  DEFAULT_SAFETY_SETTINGS,
  GeminiHelper,
  getChatContext,
  getPartsText,
  mapBaseToolToGeminiFunctionDeclaration,
} from "./utils.js";

export const GEMINI_MODEL_INFO_MAP: Record<GEMINI_MODEL, GeminiModelInfo> = {
  [GEMINI_MODEL.GEMINI_PRO]: { contextWindow: 30720 },
  [GEMINI_MODEL.GEMINI_PRO_VISION]: { contextWindow: 12288 },
  // multi-modal/multi turn
  [GEMINI_MODEL.GEMINI_PRO_LATEST]: { contextWindow: 10 ** 6 },
  [GEMINI_MODEL.GEMINI_PRO_FLASH_LATEST]: { contextWindow: 10 ** 6 },
  [GEMINI_MODEL.GEMINI_PRO_1_5_PRO_PREVIEW]: { contextWindow: 10 ** 6 },
  [GEMINI_MODEL.GEMINI_PRO_1_5_FLASH_PREVIEW]: { contextWindow: 10 ** 6 },
  [GEMINI_MODEL.GEMINI_PRO_1_5]: { contextWindow: 2 * 10 ** 6 },
  [GEMINI_MODEL.GEMINI_PRO_1_5_FLASH]: { contextWindow: 10 ** 6 },
  [GEMINI_MODEL.GEMINI_PRO_1_5_LATEST]: { contextWindow: 2 * 10 ** 6 },
  [GEMINI_MODEL.GEMINI_PRO_1_5_FLASH_LATEST]: { contextWindow: 10 ** 6 },
  [GEMINI_MODEL.GEMINI_2_0_FLASH_EXPERIMENTAL]: { contextWindow: 10 ** 6 },
  [GEMINI_MODEL.GEMINI_2_0_FLASH]: { contextWindow: 10 ** 6 },
  [GEMINI_MODEL.GEMINI_2_0_FLASH_LITE_PREVIEW]: { contextWindow: 10 ** 6 },
  [GEMINI_MODEL.GEMINI_2_0_FLASH_LITE]: { contextWindow: 10 ** 6 },
  [GEMINI_MODEL.GEMINI_2_0_FLASH_THINKING_EXP]: { contextWindow: 32768 },
  [GEMINI_MODEL.GEMINI_2_0_PRO_EXPERIMENTAL]: { contextWindow: 2 * 10 ** 6 },
};

const SUPPORT_TOOL_CALL_MODELS: GEMINI_MODEL[] = [
  GEMINI_MODEL.GEMINI_PRO,
  GEMINI_MODEL.GEMINI_PRO_VISION,
  GEMINI_MODEL.GEMINI_PRO_1_5_PRO_PREVIEW,
  GEMINI_MODEL.GEMINI_PRO_1_5_FLASH_PREVIEW,
  GEMINI_MODEL.GEMINI_PRO_1_5,
  GEMINI_MODEL.GEMINI_PRO_1_5_FLASH,
  GEMINI_MODEL.GEMINI_PRO_LATEST,
  GEMINI_MODEL.GEMINI_PRO_FLASH_LATEST,
  GEMINI_MODEL.GEMINI_PRO_1_5_LATEST,
  GEMINI_MODEL.GEMINI_PRO_1_5_FLASH_LATEST,
  GEMINI_MODEL.GEMINI_2_0_FLASH_EXPERIMENTAL,
  GEMINI_MODEL.GEMINI_2_0_FLASH,
  GEMINI_MODEL.GEMINI_2_0_PRO_EXPERIMENTAL,
];

const DEFAULT_GEMINI_PARAMS = {
  model: GEMINI_MODEL.GEMINI_PRO,
  temperature: 0.1,
  topP: 1,
  maxTokens: undefined,
};

export type GeminiConfig = Partial<typeof DEFAULT_GEMINI_PARAMS> & {
  session?: IGeminiSession;
};

/**
 * Gemini Session to manage the connection to the Gemini API
 */
export class GeminiSession implements IGeminiSession {
  private gemini: GoogleGenerativeAI;

  constructor(options: GoogleGeminiSessionOptions) {
    if (!options.apiKey) {
      options.apiKey = getEnv("GOOGLE_API_KEY")!;
    }
    if (!options.apiKey) {
      throw new Error("Set Google API Key in GOOGLE_API_KEY env variable");
    }
    this.gemini = new GoogleGenerativeAI(options.apiKey);
  }

  getGenerativeModel(metadata: GoogleModelParams): GoogleGenerativeModel {
    return this.gemini.getGenerativeModel({
      safetySettings: DEFAULT_SAFETY_SETTINGS,
      ...metadata,
    });
  }

  getResponseText(response: EnhancedGenerateContentResponse): string {
    return response.text();
  }

  getToolsFromResponse(
    response: EnhancedGenerateContentResponse,
  ): ToolCall[] | undefined {
    return response.functionCalls()?.map(
      (call: FunctionCall) =>
        ({
          name: call.name,
          input: call.args,
          id: randomUUID(),
        }) as ToolCall,
    );
  }

  async *getChatStream(
    result: GoogleStreamGenerateContentResult,
  ): GeminiChatStreamResponse {
    yield* streamConverter(result.stream, (response) => {
      const tools = this.getToolsFromResponse(response);
      const options: ToolCallLLMMessageOptions = tools?.length
        ? { toolCall: tools }
        : {};
      return {
        delta: this.getResponseText(response),
        raw: response,
        options,
      };
    });
  }

  getCompletionStream(
    result: GoogleStreamGenerateContentResult,
  ): AsyncIterable<CompletionResponse> {
    return streamConverter(result.stream, (response) => ({
      text: this.getResponseText(response),
      raw: response,
    }));
  }
}

/**
 * Gemini Session Store to manage the current Gemini sessions
 */
export class GeminiSessionStore {
  static sessions: Array<{
    session: IGeminiSession;
    options: GeminiSessionOptions;
  }> = [];

  private static getSessionId(options: GeminiSessionOptions): string {
    if (options.backend === GEMINI_BACKENDS.GOOGLE) {
      return options?.apiKey ?? "";
    }
    return "";
  }
  private static sessionMatched(
    o1: GeminiSessionOptions,
    o2: GeminiSessionOptions,
  ): boolean {
    return (
      GeminiSessionStore.getSessionId(o1) ===
      GeminiSessionStore.getSessionId(o2)
    );
  }

  static get(
    options: GeminiSessionOptions = { backend: GEMINI_BACKENDS.GOOGLE },
  ): IGeminiSession {
    let session = this.sessions.find((session) =>
      this.sessionMatched(session.options, options),
    )?.session;
    if (session) return session;

    if (options.backend === GEMINI_BACKENDS.VERTEX) {
      throw Error("No Session");
    } else {
      session = new GeminiSession(options);
    }
    this.sessions.push({ session, options });
    return session;
  }
}

/**
 * ToolCallLLM for Gemini
 */
export class Gemini extends ToolCallLLM<GeminiAdditionalChatOptions> {
  model: GEMINI_MODEL;
  temperature: number;
  topP: number;
  maxTokens?: number | undefined;
  session: IGeminiSession;

  constructor(init?: GeminiConfig) {
    super();
    this.model = init?.model ?? GEMINI_MODEL.GEMINI_PRO;
    this.temperature = init?.temperature ?? 0.1;
    this.topP = init?.topP ?? 1;
    this.maxTokens = init?.maxTokens ?? undefined;
    this.session = init?.session ?? GeminiSessionStore.get();
  }

  get supportToolCall(): boolean {
    return SUPPORT_TOOL_CALL_MODELS.includes(this.model);
  }

  get metadata(): LLMMetadata {
    return {
      model: this.model,
      temperature: this.temperature,
      topP: this.topP,
      maxTokens: this.maxTokens,
      contextWindow: GEMINI_MODEL_INFO_MAP[this.model].contextWindow,
      tokenizer: undefined,
    };
  }

  private createStartChatParams(
    params: GeminiChatParamsNonStreaming | GeminiChatParamsStreaming,
  ) {
    const context = getChatContext(params);
    const common = {
      history: context.history,
      safetySettings: DEFAULT_SAFETY_SETTINGS,
    };

    return params.tools?.length
      ? {
          ...common,
          // only if non-empty tools list
          tools: [
            {
              functionDeclarations: params.tools.map(
                mapBaseToolToGeminiFunctionDeclaration,
              ),
            },
          ],
          safetySettings: DEFAULT_SAFETY_SETTINGS,
        }
      : common;
  }

  protected async nonStreamChat(
    params: GeminiChatParamsNonStreaming,
  ): Promise<GeminiChatNonStreamResponse> {
    const context = getChatContext(params);
    const client = this.session.getGenerativeModel(this.metadata);
    const chat = client.startChat(this.createStartChatParams(params));
    const { response } = await chat.sendMessage(context.message);
    const topCandidate = response.candidates![0]!;

    const tools = this.session.getToolsFromResponse(response);
    const options: ToolCallLLMMessageOptions = tools?.length
      ? { toolCall: tools }
      : {};

    return {
      raw: response,
      message: {
        content: this.session.getResponseText(response),
        role: GeminiHelper.ROLES_FROM_GEMINI[
          topCandidate.content.role as GeminiMessageRole
        ],
        options,
      },
    };
  }

  protected async *streamChat(
    params: GeminiChatParamsStreaming,
  ): GeminiChatStreamResponse {
    const context = getChatContext(params);
    const client = this.session.getGenerativeModel(this.metadata);
    const chat = client.startChat(this.createStartChatParams(params));
    const result = await chat.sendMessageStream(context.message);
    yield* this.session.getChatStream(result);
  }

  chat(params: GeminiChatParamsStreaming): Promise<GeminiChatStreamResponse>;
  chat(
    params: GeminiChatParamsNonStreaming,
  ): Promise<GeminiChatNonStreamResponse>;
  @wrapLLMEvent
  async chat(
    params: GeminiChatParamsStreaming | GeminiChatParamsNonStreaming,
  ): Promise<GeminiChatStreamResponse | GeminiChatNonStreamResponse> {
    if (params.stream) return this.streamChat(params);
    return this.nonStreamChat(params);
  }

  complete(
    params: LLMCompletionParamsStreaming,
  ): Promise<AsyncIterable<CompletionResponse>>;
  complete(
    params: LLMCompletionParamsNonStreaming,
  ): Promise<CompletionResponse>;
  async complete(
    params: LLMCompletionParamsStreaming | LLMCompletionParamsNonStreaming,
  ): Promise<CompletionResponse | AsyncIterable<CompletionResponse>> {
    const { prompt, stream } = params;
    const client = this.session.getGenerativeModel(this.metadata);

    if (stream) {
      const result = await client.generateContentStream(
        getPartsText(
          GeminiHelper.messageContentToGeminiParts({ content: prompt }),
        ),
      );
      return this.session.getCompletionStream(result);
    }

    const result = await client.generateContent(
      getPartsText(
        GeminiHelper.messageContentToGeminiParts({ content: prompt }),
      ),
    );
    return {
      text: this.session.getResponseText(result.response),
      raw: result.response,
    };
  }
}

/**
 * Convenience function to create a new Gemini instance.
 * @param init - Optional initialization parameters for the Gemini instance.
 * @returns A new Gemini instance.
 */
export const gemini = (init?: ConstructorParameters<typeof Gemini>[0]) =>
  new Gemini(init);
