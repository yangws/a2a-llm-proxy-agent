import express from "express";
import { v4 as uuidv4 } from "uuid";
import { AzureChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage, AIMessageChunk } from "@langchain/core/messages";
import { a2aMessagesToLangChain, langChainAIMessageToA2A } from "./src/converter.js";
import { extractToolsFromMessage } from "./src/tools.js";

import {
  AgentCard,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  Message,
} from "@a2a-js/sdk";
import {
  InMemoryTaskStore,
  TaskStore,
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
  DefaultRequestHandler,
} from "@a2a-js/sdk/server";
import { A2AExpressApp } from "@a2a-js/sdk/server/express";

// Validate required environment variables
const requiredEnvVars = [
  "AZURE_OPENAI_API_KEY",
  "AZURE_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Error: ${envVar} environment variable is required`);
    process.exit(1);
  }
}

// Simple store for conversation contexts
const contexts: Map<string, Message[]> = new Map();

/**
 * LLMAgentExecutor implements the agent's core logic.
 * It acts as a proxy to Azure OpenAI, forwarding user messages
 * and returning LLM responses via the A2A protocol.
 */
class LLMAgentExecutor implements AgentExecutor {
  private cancelledTasks = new Set<string>();
  private llm: AzureChatOpenAI;
  private deploymentName: string;
  private useReasoningMode: boolean;

  constructor() {
    // Log environment variables for debugging
    console.log("[LLMAgentExecutor] Environment variables:");
    console.log("  AZURE_OPENAI_API_KEY:", process.env.AZURE_OPENAI_API_KEY ? "***set***" : "NOT SET");
    console.log("  AZURE_RESOURCE_NAME:", process.env.AZURE_RESOURCE_NAME);
    console.log("  AZURE_OPENAI_API_VERSION:", process.env.AZURE_OPENAI_API_VERSION);

    // Determine deployment name and reasoning mode
    // IMPORTANT: Make sure this deployment exists in your Azure OpenAI resource!
    // You can check available deployments in Azure Portal:
    // Azure OpenAI Studio > Deployments

    // Option 1: Use GPT-5 with reasoning mode
    this.deploymentName = "Gpt-5";
    this.useReasoningMode = true; // Enable reasoning mode for better responses

    // Option 2: Use standard GPT-4o without reasoning
    // this.deploymentName = "Gpt-4o";
    // this.useReasoningMode = false;

    // Option 3: Use GPT-5-codex (if available in your Azure resource)
    // this.deploymentName = "Gpt-5-codex";
    // this.useReasoningMode = true;

    console.log("[LLMAgentExecutor] ⚠️  IMPORTANT: Verify that deployment '" + this.deploymentName + "' exists in your Azure OpenAI resource!");

    // Check API version
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "";

    console.log("[LLMAgentExecutor] Configuration:");
    console.log("  Deployment name:", this.deploymentName);
    console.log("  API Version:", apiVersion);
    console.log("  Reasoning mode enabled:", this.useReasoningMode);

    // Prepare LangChain configuration
    const config: any = {
      azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
      azureOpenAIApiInstanceName: process.env.AZURE_RESOURCE_NAME,
      azureOpenAIApiDeploymentName: this.deploymentName,
      azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
      temperature: 1,
    };

    // Add reasoning mode parameters if enabled
    if (this.useReasoningMode) {
      console.log("  ✓ Reasoning mode enabled (using higher token limits)");
      // Note: Azure OpenAI does not support "reasoning_effort" parameter
      // Reasoning capabilities are inherent to the model (GPT-5)
      // We just increase token limits to allow for more detailed responses
      // config.maxTokens = 4000; // Higher token limit for more detailed responses
    } else {
      config.maxTokens = 2000;
    }

    console.log("[LLMAgentExecutor] Initializing LangChain Azure OpenAI client:");
    console.log("  azureOpenAIApiKey:", config.azureOpenAIApiKey ? "***set***" : "NOT SET");
    console.log("  azureOpenAIApiInstanceName:", config.azureOpenAIApiInstanceName);
    console.log("  azureOpenAIApiDeploymentName:", config.azureOpenAIApiDeploymentName);
    console.log("  azureOpenAIApiVersion:", config.azureOpenAIApiVersion);
    console.log("  temperature:", config.temperature);
    console.log("  maxTokens:", config.maxTokens);

    // Initialize LangChain client (uses Chat Completions API)
    this.llm = new AzureChatOpenAI(config);

    console.log("[LLMAgentExecutor] Client initialized successfully");
    console.log("[LLMAgentExecutor] Will use Chat Completions API:", `/openai/deployments/${this.deploymentName}/chat/completions`);
  }

  public cancelTask = async (
    taskId: string,
    _eventBus: ExecutionEventBus
  ): Promise<void> => {
    this.cancelledTasks.add(taskId);
    console.log(`[LLMAgentExecutor] Task ${taskId} marked for cancellation`);
    // The execute loop is responsible for publishing the final state
  };


  /**
   * Stream response using LangChain Chat Completions API (for gpt-4o and standard models)
   */
  private async streamWithChatCompletions(
    langchainMessages: BaseMessage[],
    taskId: string,
    contextId: string,
    eventBus: ExecutionEventBus,
    artifactId: string,
    toolDefinitions: any[]
  ): Promise<{ text: string; response: AIMessage | null }> {
    console.log(`[LLMAgentExecutor] Using Chat Completions API (LangChain) for streaming...`);

    // Bind tools if provided
    let llmToUse: AzureChatOpenAI | any = this.llm;

    if (toolDefinitions.length > 0) {
      // 直接使用工具定义，无需转换（客户端已发送标准格式）
      llmToUse = this.llm.bindTools(toolDefinitions) as any;

      console.log(
        `[LLMAgentExecutor] 🔧 Binding ${toolDefinitions.length} tool(s) to LLM:`
      );
      console.log("[LLMAgentExecutor] Tool definitions being bound:");
      console.log(JSON.stringify(toolDefinitions, null, 2));
    }

    const stream = await llmToUse.stream(langchainMessages);

    let accumulatedText = "";
    let accumulatedResponse: AIMessage | null = null;
    let accumulatedChunk: AIMessageChunk | null = null;
    let chunkCount = 0;

    console.log(`[LLMAgentExecutor] Processing Chat Completions streaming chunks...`);

    for await (const chunk of stream) {
      // Check for cancellation
      if (this.cancelledTasks.has(taskId)) {
        console.log(
          `[LLMAgentExecutor] Request cancelled during streaming for task: ${taskId}`
        );
        throw new Error("Task cancelled");
      }

      chunkCount++;
      const chunkMessage = chunk as AIMessageChunk;
      const chunkText = chunkMessage.content?.toString() ?? "";
      accumulatedText += chunkText;

      accumulatedChunk = accumulatedChunk
        ? accumulatedChunk.concat(chunkMessage)
        : chunkMessage;

      // Send incremental update to client
      if (chunkText.trim()) {
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: "artifact-update",
          taskId: taskId,
          contextId: contextId,
          artifact: {
            artifactId: artifactId,
            name: "streaming_response",
            parts: [{ kind: "text", text: chunkText }],
          },
          append: true,
          lastChunk: false,
        };
        eventBus.publish(artifactUpdate);

        // const preview = chunkText.length > 50 ? chunkText.substring(0, 50) + "..." : chunkText;
        // console.log(
        //   `[LLMAgentExecutor] 📤 Sent artifact update #${chunkCount}: "${preview}" (artifact: ${artifactId.substring(0, 8)}...)`
        // );

        // if (chunkCount % 5 === 0) {
        //   console.log(
        //     `[LLMAgentExecutor] Streamed ${chunkCount} chunks, ${accumulatedText.length} chars so far...`
        //   );
        // }
      }
    }

    console.log(
      `[LLMAgentExecutor] Chat Completions streaming complete: ${chunkCount} chunks, ${accumulatedText.length} total chars`
    );

    if (accumulatedChunk) {
      accumulatedResponse = new AIMessage({
        id: accumulatedChunk.id,
        content: accumulatedChunk.content,
        additional_kwargs: accumulatedChunk.additional_kwargs,
        response_metadata: accumulatedChunk.response_metadata,
        tool_calls: accumulatedChunk.tool_calls,
        invalid_tool_calls: accumulatedChunk.invalid_tool_calls,
        usage_metadata: accumulatedChunk.usage_metadata,
      });
    }

    return { text: accumulatedText, response: accumulatedResponse };
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const userMessage = requestContext.userMessage;
    const existingTask = requestContext.task;
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;

    console.log(
      `[LLMAgentExecutor] Processing message ${userMessage.messageId} for task ${taskId} (context: ${contextId})`
    );

    // ========== Extract tool definitions from message ==========
    const toolDefinitions = extractToolsFromMessage(userMessage);

    if (toolDefinitions.length > 0) {
      console.log(
        `[LLMAgentExecutor] 📦 Extracted ${toolDefinitions.length} tool(s):`,
        toolDefinitions.map(t => t.function.name).join(", ")
      );
    } else {
      console.log("[LLMAgentExecutor] No tools provided in this message");
    }
    // ==========================================================

    // 1. Publish initial Task event if it's a new task
    if (!existingTask) {
      const initialTask: Task = {
        kind: "task",
        id: taskId,
        contextId: contextId,
        status: {
          state: "submitted",
          timestamp: new Date().toISOString(),
        },
        history: [userMessage],
        metadata: userMessage.metadata,
      };
      eventBus.publish(initialTask);
    }

    // 2. Publish "working" status update
    const workingStatusUpdate: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId: taskId,
      contextId: contextId,
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          messageId: uuidv4(),
          parts: [
            {
              kind: "text",
              text: "Processing your request with Azure OpenAI...",
            },
          ],
          taskId: taskId,
          contextId: contextId,
        },
        timestamp: new Date().toISOString(),
      },
      final: false,
    };
    eventBus.publish(workingStatusUpdate);

    // 3. Prepare conversation history for LangChain
    const historyForLLM = contexts.get(contextId) || [];
    if (!historyForLLM.find((m) => m.messageId === userMessage.messageId)) {
      historyForLLM.push(userMessage);
    }
    contexts.set(contextId, historyForLLM);

    // Convert A2A messages to LangChain messages using the converter
    const langchainMessages: BaseMessage[] = a2aMessagesToLangChain(historyForLLM);

    if (langchainMessages.length === 0) {
      console.warn(
        `[LLMAgentExecutor] No valid text messages found in history for task ${taskId}.`
      );
      const failureUpdate: TaskStatusUpdateEvent = {
        kind: "status-update",
        taskId: taskId,
        contextId: contextId,
        status: {
          state: "failed",
          message: {
            kind: "message",
            role: "agent",
            messageId: uuidv4(),
            parts: [{ kind: "text", text: "No message found to process." }],
            taskId: taskId,
            contextId: contextId,
          },
          timestamp: new Date().toISOString(),
        },
        final: true,
      };
      eventBus.publish(failureUpdate);
      return;
    }

    try {
      // 4. Check for cancellation before calling LLM
      if (this.cancelledTasks.has(taskId)) {
        console.log(
          `[LLMAgentExecutor] Request cancelled before LLM call for task: ${taskId}`
        );
        const cancelledUpdate: TaskStatusUpdateEvent = {
          kind: "status-update",
          taskId: taskId,
          contextId: contextId,
          status: {
            state: "canceled",
            timestamp: new Date().toISOString(),
          },
          final: true,
        };
        eventBus.publish(cancelledUpdate);
        this.cancelledTasks.delete(taskId);
        return;
      }

      // 5. Call Azure OpenAI via Chat Completions API (streaming)
      const artifactId = uuidv4();
      let accumulatedText = "";
      let accumulatedResponse: AIMessage | null = null;

      console.log(
        `[LLMAgentExecutor] Sending ${langchainMessages.length} messages to Azure OpenAI Chat Completions API`
      );
      console.log(`[LLMAgentExecutor] Reasoning mode:`, this.useReasoningMode ? "enabled" : "disabled");
      console.log(`[LLMAgentExecutor] Messages preview:`, langchainMessages.map(m => ({
        type: m.constructor.name,
        contentLength: m.content.toString().length,
        contentPreview: m.content.toString().substring(0, 100)
      })));

      // Use Chat Completions API for all models
      const result = await this.streamWithChatCompletions(
        langchainMessages,
        taskId,
        contextId,
        eventBus,
        artifactId,
        toolDefinitions
      );

      accumulatedText = result.text;
      accumulatedResponse = result.response;

      // 6. Log the complete AIMessage received from LLM
      if (accumulatedResponse) {
        console.log(`[LLMAgentExecutor] ========== COMPLETE AI MESSAGE FROM LLM ==========`);
        console.log(`[LLMAgentExecutor] Message type:`, accumulatedResponse.constructor.name);
        console.log(`[LLMAgentExecutor] Content length:`, accumulatedResponse.content.toString().length, "chars");
        console.log(`[LLMAgentExecutor] Content:`, accumulatedResponse.content.toString());

        if (accumulatedResponse.tool_calls && accumulatedResponse.tool_calls.length > 0) {
          console.log(`[LLMAgentExecutor] Tool calls (${accumulatedResponse.tool_calls.length}):`);
          accumulatedResponse.tool_calls.forEach((tc, index) => {
            console.log(`[LLMAgentExecutor]   ${index + 1}. ${tc.name}:`, JSON.stringify(tc.args));
          });
        } else {
          console.log(`[LLMAgentExecutor] Tool calls: none`);
        }

        if (accumulatedResponse.response_metadata) {
          console.log(`[LLMAgentExecutor] Response metadata:`, JSON.stringify(accumulatedResponse.response_metadata, null, 2));
        }

        console.log(`[LLMAgentExecutor] Full AIMessage object:`, JSON.stringify(accumulatedResponse, null, 2));
        console.log(`[LLMAgentExecutor] =================================================`);
      } else {
        console.log(`[LLMAgentExecutor] No AIMessage received from LLM (accumulatedResponse is null)`);
      }

      // 7. Send final chunk marker
      const finalArtifactUpdate: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId: taskId,
        contextId: contextId,
        artifact: {
          artifactId: artifactId,
          name: "streaming_response",
          parts: [
            {
              kind: "text",
              text: "", // Empty text for the final marker
            },
          ],
        },
        append: false,
        lastChunk: true, // Mark as final chunk
      };
      eventBus.publish(finalArtifactUpdate);

      console.log(
        `[LLMAgentExecutor] 📤 Sent final artifact marker (lastChunk: true, artifact: ${artifactId.substring(0, 8)}...)`
      );

      // 8. Check for cancellation after streaming
      if (this.cancelledTasks.has(taskId)) {
        console.log(
          `[LLMAgentExecutor] Request cancelled after streaming for task: ${taskId}`
        );
        const cancelledUpdate: TaskStatusUpdateEvent = {
          kind: "status-update",
          taskId: taskId,
          contextId: contextId,
          status: {
            state: "canceled",
            timestamp: new Date().toISOString(),
          },
          final: true,
        };
        eventBus.publish(cancelledUpdate);
        this.cancelledTasks.delete(taskId);
        return;
      }

      // 9. Convert the complete LangChain AIMessage to A2A Message format
      // This embeds the full AIMessage (with tool_calls, etc.) into a DataPart
      const agentMessage: Message = accumulatedResponse
        ? langChainAIMessageToA2A(
          accumulatedResponse,
          uuidv4(),
          taskId,
          contextId
        )
        : {
          kind: "message",
          role: "agent",
          messageId: uuidv4(),
          parts: [{ kind: "text" as const, text: accumulatedText }],
          taskId: taskId,
          contextId: contextId,
        };

      console.log(
        `[LLMAgentExecutor] Complete response has ${agentMessage.parts.length} part(s)`
      );
      console.log(
        `[LLMAgentExecutor] Part types: ${agentMessage.parts.map(p => p.kind).join(", ")}`
      );

      // 10. Log the complete message being sent to client
      console.log(
        `[LLMAgentExecutor] ========== FINAL AGENT MESSAGE TO CLIENT ==========`
      );
      console.log(
        `[LLMAgentExecutor] Complete message structure:`
      );
      console.log(JSON.stringify(agentMessage, null, 2));
      console.log(
        `[LLMAgentExecutor] ======================================================`
      );

      historyForLLM.push(agentMessage);
      contexts.set(contextId, historyForLLM);

      // 11. Publish final task status update
      const finalUpdate: TaskStatusUpdateEvent = {
        kind: "status-update",
        taskId: taskId,
        contextId: contextId,
        status: {
          state: "completed",
          message: agentMessage,
          timestamp: new Date().toISOString(),
        },
        final: true,
      };
      eventBus.publish(finalUpdate);

      console.log(
        `[LLMAgentExecutor] Task ${taskId} completed successfully with streaming`
      );
    } catch (error: any) {
      console.error(`[LLMAgentExecutor] ========== ERROR DETAILS ==========`);
      console.error(`[LLMAgentExecutor] Error processing task ${taskId}`);
      console.error(`[LLMAgentExecutor] Error type:`, error.constructor.name);
      console.error(`[LLMAgentExecutor] Error message:`, error.message);
      console.error(`[LLMAgentExecutor] Error code:`, error.code);
      console.error(`[LLMAgentExecutor] Error status:`, error.status);
      console.error(`[LLMAgentExecutor] LangChain error code:`, error.lc_error_code);

      if (error.response) {
        console.error(`[LLMAgentExecutor] Response status:`, error.response.status);
        console.error(`[LLMAgentExecutor] Response data:`, error.response.data);
      }

      console.error(`[LLMAgentExecutor] Full error object:`, JSON.stringify(error, null, 2));
      console.error(`[LLMAgentExecutor] ===================================`);

      // Check if cancelled during error handling
      if (this.cancelledTasks.has(taskId)) {
        const cancelledUpdate: TaskStatusUpdateEvent = {
          kind: "status-update",
          taskId: taskId,
          contextId: contextId,
          status: {
            state: "canceled",
            timestamp: new Date().toISOString(),
          },
          final: true,
        };
        eventBus.publish(cancelledUpdate);
        this.cancelledTasks.delete(taskId);
        return;
      }

      const errorUpdate: TaskStatusUpdateEvent = {
        kind: "status-update",
        taskId: taskId,
        contextId: contextId,
        status: {
          state: "failed",
          message: {
            kind: "message",
            role: "agent",
            messageId: uuidv4(),
            parts: [
              {
                kind: "text",
                text: `Error processing request: ${error.message || "Unknown error"}`,
              },
            ],
            taskId: taskId,
            contextId: contextId,
          },
          timestamp: new Date().toISOString(),
        },
        final: true,
      };
      eventBus.publish(errorUpdate);
    } finally {
      // Clean up cancelled task tracking
      this.cancelledTasks.delete(taskId);
    }
  }
}

// --- Agent Card Configuration ---

const llmAgentCard: AgentCard = {
  name: "LLM Proxy Agent",
  description:
    "An A2A agent that acts as a proxy to Azure OpenAI GPT Model. It forwards user messages to the LLM and returns responses.",
  url: "http://localhost:41242/",
  provider: {
    organization: "A2A Samples",
    url: "https://example.com/a2a-samples",
  },
  version: "1.0.0",
  protocolVersion: "1.0.0",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  securitySchemes: undefined,
  security: undefined,
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "task-status"],
  skills: [
    {
      id: "general_chat",
      name: "General Chat",
      description:
        "Chat with Azure OpenAI GPT-4. Ask questions, get help, or have a conversation about any topic.",
      tags: ["chat", "llm", "gpt-4", "azure-openai"],
      examples: [
        "What is the capital of France?",
        "Explain quantum computing in simple terms",
        "Write a haiku about programming",
        "Help me debug this Python code",
        "What are the benefits of microservices?",
      ],
      inputModes: ["text"],
      outputModes: ["text", "task-status"],
    },
  ],
  supportsAuthenticatedExtendedCard: false,
};

// --- Server Setup ---

async function main() {
  console.log("[LLMAgent] Starting server...");

  // 1. Create TaskStore
  const taskStore: TaskStore = new InMemoryTaskStore();

  // 2. Create AgentExecutor
  const agentExecutor: AgentExecutor = new LLMAgentExecutor();

  // 3. Create DefaultRequestHandler
  const requestHandler = new DefaultRequestHandler(
    llmAgentCard,
    taskStore,
    agentExecutor
  );

  // 4. Create and setup A2AExpressApp
  const appBuilder = new A2AExpressApp(requestHandler);
  const expressApp = appBuilder.setupRoutes(express());

  // 5. Start the server
  const PORT = process.env.PORT || 41242;
  expressApp.listen(PORT, () => {
    console.log(
      `[LLMAgent] Server started on http://localhost:${PORT}`
    );
    console.log(
      `[LLMAgent] Agent Card: http://localhost:${PORT}/.well-known/agent-card.json`
    );
    console.log("[LLMAgent] Environment:");
    console.log(`  - Azure Resource: ${process.env.AZURE_RESOURCE_NAME}`);
    console.log(`  - API Version: ${process.env.AZURE_OPENAI_API_VERSION}`);
    console.log("[LLMAgent] Press Ctrl+C to stop the server");
  });
}

main().catch((error) => {
  console.error("[LLMAgent] Fatal error:", error);
  process.exit(1);
});
