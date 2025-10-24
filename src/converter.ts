/**
 * Type conversion utilities for bridging A2A SDK and LangChain formats.
 *
 * This module provides bidirectional conversion between:
 * - A2A Message ↔ LangChain BaseMessage
 * - LangChain AIMessage with tool_calls ↔ A2A Message with embedded LangChain data
 */

import type { Message, Part, TextPart, DataPart } from "@a2a-js/sdk";
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  type MessageContent,
} from "@langchain/core/messages";
import type { ToolCall as LangChainToolCall } from "@langchain/core/messages/tool";

/**
 * Converts A2A Message to LangChain BaseMessage.
 *
 * A2A messages have a role field (user/agent) and parts array.
 * LangChain uses specific message classes (HumanMessage, AIMessage, SystemMessage).
 *
 * @param message - A2A SDK Message object
 * @returns Corresponding LangChain BaseMessage
 */
export function a2aMessageToLangChain(message: Message): BaseMessage {
  // Extract text content from parts
  const content = extractTextContent(message.parts);

  // Convert based on role
  switch (message.role) {
    case "user":
      return new HumanMessage({
        content,
        id: message.messageId,
      });

    case "agent":
      return new AIMessage({
        content,
        id: message.messageId,
      });

    default:
      // Fallback to HumanMessage for unknown roles
      return new HumanMessage({
        content,
        id: message.messageId,
      });
  }
}

/**
 * Converts an array of A2A Messages to LangChain BaseMessage array.
 *
 * @param messages - Array of A2A SDK Message objects
 * @returns Array of LangChain BaseMessage objects
 */
export function a2aMessagesToLangChain(messages: Message[]): BaseMessage[] {
  return messages.map((m) => a2aMessageToLangChain(m));
}

/**
 * Extracts text content from A2A message parts.
 *
 * @param parts - Array of A2A Part objects
 * @returns Concatenated text content
 */
function extractTextContent(parts: Part[]): string {
  return parts
    .filter((part): part is TextPart => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Converts LangChain AIMessage to A2A Message format.
 *
 * This follows the client's expected format:
 * - Creates a TextPart with the text content
 * - Creates a DataPart embedding the complete LangChain AIMessage object
 *
 * This allows the client to:
 * 1. Display the text content
 * 2. Extract the full AIMessage (with tool_calls, etc.) using extractLangChainMessageFromA2A()
 *
 * @param aiMessage - LangChain AIMessage object
 * @param messageId - A2A message ID
 * @param taskId - Optional task ID for the message
 * @param contextId - Optional context ID for the message
 * @returns A2A SDK Message object
 */
export function langChainAIMessageToA2A(
  aiMessage: AIMessage,
  messageId: string,
  taskId?: string,
  contextId?: string
): Message {
  // Extract text content
  const content =
    typeof aiMessage.content === "string"
      ? aiMessage.content
      : extractContentText(aiMessage.content);

  // Build parts array
  const parts: Part[] = [];

  // 1. Add text content as TextPart (if any)
  if (content.trim()) {
    const textPart: TextPart = {
      kind: "text",
      text: content,
    };
    parts.push(textPart);
  }

  // 2. Embed the complete LangChain AIMessage as DataPart
  // This is critical for the client to extract tool_calls, additional_kwargs, etc.
  const aiMessageData: DataPart = {
    kind: "data",
    data: {
      content: aiMessage.content,
      id: aiMessage.id,
      tool_calls: aiMessage.tool_calls,
      additional_kwargs: aiMessage.additional_kwargs,
      response_metadata: aiMessage.response_metadata,
    },
    metadata: {
      description: "LangChain AIMessage",
      type: "langchain_ai_message",
    },
  };
  parts.push(aiMessageData);

  // If no parts were created, add a default empty text part
  if (parts.length === 0) {
    parts.push({
      kind: "text",
      text: "[No content received from LLM]",
    });
  }

  return {
    kind: "message",
    messageId,
    role: "agent",
    parts,
    taskId,
    contextId,
  };
}

/**
 * Extracts text from LangChain MessageContent.
 *
 * @param content - LangChain message content (can be string or array)
 * @returns Text string
 */
function extractContentText(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter(
        (item): item is { type: "text"; text: string } =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "text"
      )
      .map((item) => item.text)
      .join("\n");
  }

  return "";
}

/**
 * Extracts LangChain AIMessage from A2A Message DataPart.
 *
 * The remote server embeds LangChain AIMessage objects in A2A Message parts
 * with kind='data'. This function finds and extracts the first AIMessage.
 *
 * @param message - A2A Message object
 * @returns LangChain AIMessage if found, null otherwise
 */
export function extractLangChainMessageFromA2A(
  message: Message
): AIMessage | null {
  // Find DataPart containing LangChain message
  const dataPart = message.parts.find(
    (part): part is DataPart => part.kind === "data"
  );

  if (!dataPart || !dataPart.data) {
    return null;
  }

  // Check if data contains LangChain message structure
  const data = dataPart.data;

  // LangChain AIMessage should have these properties
  if (typeof data === "object" && data !== null) {
    // Check for AIMessage signature (content and optional tool_calls)
    if ("content" in data) {
      // Reconstruct AIMessage from the data
      return new AIMessage({
        content: data.content as MessageContent,
        id: data.id as string | undefined,
        tool_calls: data.tool_calls as LangChainToolCall[] | undefined,
        additional_kwargs: data.additional_kwargs as
          | Record<string, unknown>
          | undefined,
        response_metadata: data.response_metadata as
          | Record<string, unknown>
          | undefined,
      });
    }
  }

  return null;
}

/**
 * Extracts tool calls from LangChain AIMessage.
 *
 * @param aiMessage - LangChain AIMessage object
 * @returns Array of LangChain ToolCall objects (empty array if none)
 */
export function extractToolCallsFromAIMessage(
  aiMessage: AIMessage
): LangChainToolCall[] {
  if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
    return [];
  }

  return aiMessage.tool_calls;
}

/**
 * Parsed LangChain response containing text content and tool calls.
 */
export interface ParsedLangChainResponse {
  /** Text content from the AIMessage */
  content: string;
  /** Tool calls requested by the agent */
  toolCalls: LangChainToolCall[];
  /** Original AIMessage object */
  aiMessage: AIMessage;
}

/**
 * Parses A2A Message to extract LangChain response data.
 *
 * This extracts both text content and tool calls from the remote server's response.
 *
 * @param message - A2A Message from remote server
 * @returns Parsed response data, or null if no LangChain message found
 */
export function parseA2AMessageForLangChain(
  message: Message
): ParsedLangChainResponse | null {
  // Step 1: Extract LangChain AIMessage from A2A DataPart
  const aiMessage = extractLangChainMessageFromA2A(message);

  if (!aiMessage) {
    return null;
  }

  // Step 2: Extract text content
  const content = extractContentText(aiMessage.content);

  // Step 3: Extract tool calls
  const toolCalls = extractToolCallsFromAIMessage(aiMessage);

  return {
    content,
    toolCalls,
    aiMessage,
  };
}
