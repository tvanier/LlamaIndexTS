import type {
  NonStreamingChatEngineParams,
  StreamingChatEngineParams,
} from "@llamaindex/core/chat-engine";
import type { MessageContent } from "@llamaindex/core/llms";
import type { BaseRetriever } from "@llamaindex/core/retriever";
import { EngineResponse, MetadataMode } from "@llamaindex/core/schema";
import { OpenAIAgent, type OpenAIAgentParams } from "@llamaindex/openai";

export interface ContextAwareConfig {
  contextRetriever: BaseRetriever;
}

export interface ContextAwareState {
  contextRetriever: BaseRetriever;
  retrievedContext: string | null;
}

// TODO: support any LLMAgent
export type SupportedAgent = typeof OpenAIAgent;
export type AgentParams = OpenAIAgentParams;

/**
 * ContextAwareAgentRunner enhances the base AgentRunner with the ability to retrieve and inject relevant context
 * for each query. This allows the agent to access and utilize appropriate information from a given index or retriever,
 * providing more informed and context-specific responses to user queries.
 */
export function withContextAwareness(Base: SupportedAgent) {
  return class ContextAwareAgent extends Base {
    public readonly contextRetriever: BaseRetriever;
    public retrievedContext: string | null = null;

    constructor(params: AgentParams & ContextAwareConfig) {
      super(params);
      this.contextRetriever = params.contextRetriever;
    }

    async retrieveContext(query: MessageContent): Promise<string> {
      const nodes = await this.contextRetriever.retrieve({ query });
      return nodes
        .map((node) => node.node.getContent(MetadataMode.NONE))
        .join("\n");
    }

    async injectContext(context: string): Promise<void> {
      const systemMessage = this.chatHistory.find(
        (msg) => msg.role === "system",
      );
      if (systemMessage) {
        systemMessage.content = `${context}\n\n${systemMessage.content}`;
      } else {
        this.chatHistory.unshift({ role: "system", content: context });
      }
    }

    async chat(params: NonStreamingChatEngineParams): Promise<EngineResponse>;
    async chat(
      params: StreamingChatEngineParams,
    ): Promise<ReadableStream<EngineResponse>>;
    async chat(
      params: NonStreamingChatEngineParams | StreamingChatEngineParams,
    ): Promise<EngineResponse | ReadableStream<EngineResponse>> {
      const context = await this.retrieveContext(params.message);
      await this.injectContext(context);

      if ("stream" in params && params.stream === true) {
        return super.chat(params);
      } else {
        return super.chat(params as NonStreamingChatEngineParams);
      }
    }
  };
}
