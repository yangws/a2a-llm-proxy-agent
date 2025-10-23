import express from "express";
import { v4 as uuidv4 } from "uuid";
import { AzureChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";

import {
  AgentCard,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  TextPart,
  Message,
  Part,
  DataPart,
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
 * Parses an AIMessage from LangChain into A2A Part objects.
 * Extracts text content, tool calls, and metadata into structured parts.
 *
 * @param aiMessage - The AIMessage from LangChain
 * @returns Array of A2A Part objects
 */
function parseAIMessageToParts(aiMessage: AIMessage): Part[] {
  const parts: Part[] = [];

  // 1. Extract text content
  let textContent = "";
  if (typeof aiMessage.content === "string") {
    textContent = aiMessage.content;
  } else if (Array.isArray(aiMessage.content)) {
    // Content can be an array of content blocks
    for (const block of aiMessage.content) {
      if (typeof block === "string") {
        textContent += block;
      } else if (block && typeof block === "object") {
        // Handle structured content blocks
        if ("text" in block && typeof block.text === "string") {
          textContent += block.text;
        } else if ("type" in block && block.type === "text" && "text" in block) {
          textContent += block.text;
        }
      }
    }
  }

  // Always add text part if there's any text content
  if (textContent.trim()) {
    const textPart: TextPart = {
      kind: "text",
      text: textContent,
    };
    parts.push(textPart);
  }

  // 2. Extract tool calls if present
  if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
    const toolCallsPart: DataPart = {
      kind: "data",
      data: {
        type: "tool_calls",
        tool_calls: aiMessage.tool_calls,
      },
      metadata: {
        description: "Tool calls requested by the LLM",
      },
    };
    parts.push(toolCallsPart);
  }

  // 3. Extract additional kwargs if present (may contain function calls, etc.)
  if (aiMessage.additional_kwargs && Object.keys(aiMessage.additional_kwargs).length > 0) {
    // Check for function_call (older OpenAI format)
    if ("function_call" in aiMessage.additional_kwargs && aiMessage.additional_kwargs.function_call) {
      const functionCallPart: DataPart = {
        kind: "data",
        data: {
          type: "function_call",
          function_call: aiMessage.additional_kwargs.function_call,
        },
        metadata: {
          description: "Function call requested by the LLM",
        },
      };
      parts.push(functionCallPart);
    }

    // Include other additional_kwargs as a separate data part if they exist
    const otherKwargs = { ...aiMessage.additional_kwargs };
    delete (otherKwargs as any).function_call;

    if (Object.keys(otherKwargs).length > 0) {
      const additionalDataPart: DataPart = {
        kind: "data",
        data: {
          type: "additional_data",
          ...otherKwargs,
        },
        metadata: {
          description: "Additional data from LLM response",
        },
      };
      parts.push(additionalDataPart);
    }
  }

  // 4. Extract response metadata if present and meaningful
  if (aiMessage.response_metadata && Object.keys(aiMessage.response_metadata).length > 0) {
    const metadataPart: DataPart = {
      kind: "data",
      data: {
        type: "response_metadata",
        ...aiMessage.response_metadata,
      },
      metadata: {
        description: "Metadata from LLM response (model info, tokens, etc.)",
      },
    };
    parts.push(metadataPart);
  }

  // If no parts were created, add a default empty text part
  if (parts.length === 0) {
    parts.push({
      kind: "text",
      text: "[No content received from LLM]",
    });
  }

  return parts;
}

/**
 * LLMAgentExecutor implements the agent's core logic.
 * It acts as a proxy to Azure OpenAI, forwarding user messages
 * and returning LLM responses via the A2A protocol.
 */
class LLMAgentExecutor implements AgentExecutor {
  private cancelledTasks = new Set<string>();
  private llm: AzureChatOpenAI;

  constructor() {
    // Log environment variables for debugging
    console.log("[LLMAgentExecutor] Environment variables:");
    console.log("  AZURE_OPENAI_API_KEY:", process.env.AZURE_OPENAI_API_KEY ? "***set***" : "NOT SET");
    console.log("  AZURE_RESOURCE_NAME:", process.env.AZURE_RESOURCE_NAME);
    console.log("  AZURE_OPENAI_API_VERSION:", process.env.AZURE_OPENAI_API_VERSION);

    // Prepare configuration object
    const config = {
      azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
      azureOpenAIApiInstanceName: process.env.AZURE_RESOURCE_NAME,
      // azureOpenAIApiDeploymentName: "Gpt-4o",
      azureOpenAIApiDeploymentName: "Gpt-4.1",
      azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
      temperature: 0.7,
      maxTokens: 2000,
    };

    console.log("[LLMAgentExecutor] Initializing AzureChatOpenAI with config:");
    console.log("  azureOpenAIApiKey:", config.azureOpenAIApiKey ? "***set***" : "NOT SET");
    console.log("  azureOpenAIApiInstanceName:", config.azureOpenAIApiInstanceName);
    console.log("  azureOpenAIApiDeploymentName:", config.azureOpenAIApiDeploymentName);
    console.log("  azureOpenAIApiVersion:", config.azureOpenAIApiVersion);
    console.log("  temperature:", config.temperature);
    console.log("  maxTokens:", config.maxTokens);

    // Initialize Azure OpenAI client using LangChain
    this.llm = new AzureChatOpenAI(config);

    console.log("[LLMAgentExecutor] AzureChatOpenAI initialized successfully");
  }

  public cancelTask = async (
    taskId: string,
    _eventBus: ExecutionEventBus
  ): Promise<void> => {
    this.cancelledTasks.add(taskId);
    console.log(`[LLMAgentExecutor] Task ${taskId} marked for cancellation`);
    // The execute loop is responsible for publishing the final state
  };

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

    // Convert A2A messages to LangChain messages
    const langchainMessages: BaseMessage[] = [];
    for (const m of historyForLLM) {
      const textParts = m.parts.filter(
        (p): p is TextPart => p.kind === "text" && !!(p as TextPart).text
      );
      const textContent = textParts.map((p) => (p as TextPart).text).join("\n");

      if (!textContent) continue;

      if (m.role === "user") {
        langchainMessages.push(new HumanMessage(textContent));
      } else if (m.role === "agent") {
        langchainMessages.push(new AIMessage(textContent));
      }
    }

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

      // 5. Call Azure OpenAI via LangChain (streaming)
      console.log(
        `[LLMAgentExecutor] Sending ${langchainMessages.length} messages to Azure OpenAI (streaming)`
      );
      console.log(`[LLMAgentExecutor] Messages preview:`, langchainMessages.map(m => ({
        type: m.constructor.name,
        contentLength: m.content.toString().length,
        contentPreview: m.content.toString().substring(0, 100)
      })));

      console.log(`[LLMAgentExecutor] Starting streaming LLM call...`);
      const stream = await this.llm.stream(langchainMessages);

      // 6. Process streaming response
      const artifactId = uuidv4();
      let accumulatedText = "";
      let accumulatedResponse: AIMessage | null = null;
      let chunkCount = 0;

      console.log(`[LLMAgentExecutor] Processing streaming chunks...`);

      for await (const chunk of stream) {
        // Check for cancellation during streaming
        if (this.cancelledTasks.has(taskId)) {
          console.log(
            `[LLMAgentExecutor] Request cancelled during streaming for task: ${taskId}`
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

        chunkCount++;
        const chunkText = chunk.content.toString();
        accumulatedText += chunkText;

        // Accumulate the full response (for metadata extraction later)
        if (!accumulatedResponse) {
          accumulatedResponse = chunk;
        } else {
          // Merge chunk data into accumulated response
          accumulatedResponse.content = accumulatedText;
          if (chunk.response_metadata) {
            accumulatedResponse.response_metadata = chunk.response_metadata;
          }
          if (chunk.tool_calls && chunk.tool_calls.length > 0) {
            accumulatedResponse.tool_calls = [
              ...(accumulatedResponse.tool_calls || []),
              ...chunk.tool_calls
            ];
          }
        }

        // Send incremental update to client
        if (chunkText.trim()) {
          const artifactUpdate: TaskArtifactUpdateEvent = {
            kind: "artifact-update",
            taskId: taskId,
            contextId: contextId,
            artifact: {
              artifactId: artifactId,
              name: "streaming_response",
              parts: [
                {
                  kind: "text",
                  text: chunkText,
                },
              ],
            },
            append: true, // Append to existing artifact
            lastChunk: false, // Will be set to true for the last chunk
          };
          eventBus.publish(artifactUpdate);

          // Log every artifact update sent
          const preview = chunkText.length > 50 ? chunkText.substring(0, 50) + "..." : chunkText;
          console.log(
            `[LLMAgentExecutor] 📤 Sent artifact update #${chunkCount}: "${preview}" (artifact: ${artifactId.substring(0, 8)}...)`
          );

          if (chunkCount % 5 === 0) {
            console.log(
              `[LLMAgentExecutor] Streamed ${chunkCount} chunks, ${accumulatedText.length} chars so far...`
            );
          }
        }
      }

      console.log(
        `[LLMAgentExecutor] Streaming complete: ${chunkCount} chunks, ${accumulatedText.length} total chars`
      );

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

      // 9. Parse the complete response into structured parts
      const responseParts = accumulatedResponse
        ? parseAIMessageToParts(accumulatedResponse)
        : [{ kind: "text" as const, text: accumulatedText }];

      console.log(
        `[LLMAgentExecutor] Complete response has ${responseParts.length} part(s)`
      );
      console.log(
        `[LLMAgentExecutor] Part types: ${responseParts.map(p => p.kind).join(", ")}`
      );

      // 10. Create agent message with all structured parts
      const agentMessage: Message = {
        kind: "message",
        role: "agent",
        messageId: uuidv4(),
        parts: responseParts,
        taskId: taskId,
        contextId: contextId,
      };

      // Log the complete message being sent to client
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
    "An A2A agent that acts as a proxy to Azure OpenAI GPT-4. It forwards user messages to the LLM and returns responses.",
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
