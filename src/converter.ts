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
  ToolMessage,
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
  const toolMessage = extractToolMessage(message);
  if (toolMessage) {
    return toolMessage;
  }

  const aiMessage = extractAIMessage(message);
  if (aiMessage) {
    return aiMessage;
  }

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
 * Attempts to convert a tool result DataPart into a LangChain ToolMessage.
 *
 * @param message - Source A2A message
 * @returns ToolMessage if conversion succeeds, null otherwise
 */
function extractToolMessage(message: Message): ToolMessage | null {
  for (const part of message.parts) {
    if (part.kind !== "data") {
      continue;
    }

    const dataPart = part as DataPart;
    const metadata =
      typeof dataPart.metadata === "object" && dataPart.metadata
        ? (dataPart.metadata as Record<string, unknown>)
        : null;

    if (!metadata) {
      continue;
    }

    const metadataFormat =
      typeof metadata["format"] === "string" ? metadata["format"] : undefined;
    const metadataType =
      typeof metadata["type"] === "string" ? metadata["type"] : undefined;
    const metadataCount =
      typeof metadata["count"] === "number" ? metadata["count"] : undefined;

    if (metadataFormat !== "langchain" || metadataType !== "tool-messages") {
      continue;
    }

    if (
      !dataPart.data ||
      typeof dataPart.data !== "object" ||
      Array.isArray(dataPart.data)
    ) {
      continue;
    }

    const raw = dataPart.data as Record<string, unknown>;
    const toolMessages = raw["toolMessages"];

    if (!Array.isArray(toolMessages) || toolMessages.length === 0) {
      continue;
    }

    if (
      metadataCount !== undefined &&
      metadataCount !== toolMessages.length
    ) {
      console.warn(
        "[Converter] Tool message count mismatch; metadata count:",
        metadataCount,
        "array length:",
        toolMessages.length,
        "messageId:",
        message.messageId
      );
    }

    const entry = toolMessages[0];

    if (!entry || typeof entry !== "object") {
      continue;
    }

    const toolMessage = constructToolMessageFromEntry(
      entry as Record<string, unknown>,
      message.messageId
    );

    if (toolMessage) {
      return toolMessage;
    }
  }

  return null;
}

/**
 * Attempts to convert an embedded LangChain AIMessage DataPart back into an AIMessage.
 *
 * @param message - Source A2A message
 * @returns AIMessage if reconstruction succeeds, null otherwise
 */
function extractAIMessage(message: Message): AIMessage | null {
  const fallbackContent = extractTextContent(message.parts);

  for (const part of message.parts) {
    if (part.kind !== "data") {
      continue;
    }

    const dataPart = part as DataPart;
    const metadata =
      typeof dataPart.metadata === "object" && dataPart.metadata
        ? (dataPart.metadata as Record<string, unknown>)
        : null;

    if (!metadata || metadata["type"] !== "langchain_ai_message") {
      continue;
    }

    if (
      !dataPart.data ||
      typeof dataPart.data !== "object" ||
      Array.isArray(dataPart.data)
    ) {
      continue;
    }

    const data = dataPart.data as Record<string, unknown>;

    const content = normalizeAIContent(data["content"], fallbackContent);
    const additional_kwargs = isRecord(data["additional_kwargs"])
      ? (data["additional_kwargs"] as Record<string, unknown>)
      : {};
    const tool_calls = normalizeToolCalls(
      data["tool_calls"],
      additional_kwargs
    );
    const invalid_tool_calls = normalizeInvalidToolCalls(
      data["invalid_tool_calls"]
    );
    const response_metadata = isRecord(data["response_metadata"])
      ? (data["response_metadata"] as Record<string, unknown>)
      : {};
    const usage_metadata = isRecord(data["usage_metadata"])
      ? (data["usage_metadata"] as Record<string, unknown>)
      : undefined;

    const aiMessagePayload: Record<string, unknown> = {
      id:
        typeof data["id"] === "string"
          ? (data["id"] as string)
          : message.messageId,
      content,
      additional_kwargs,
      response_metadata,
    };

    if (tool_calls && tool_calls.length > 0) {
      aiMessagePayload.tool_calls = tool_calls;
    }

    if (invalid_tool_calls && invalid_tool_calls.length > 0) {
      aiMessagePayload.invalid_tool_calls = invalid_tool_calls;
    }

    if (usage_metadata) {
      aiMessagePayload.usage_metadata = usage_metadata;
    }

    return new AIMessage(aiMessagePayload);
  }

  return null;
}

/**
 * Constructs a LangChain ToolMessage from a client-provided toolMessages entry.
 *
 * @param entry - Raw entry object
 * @param fallbackId - Fallback tool_call_id
 * @returns ToolMessage or null if parsing fails
 */
function constructToolMessageFromEntry(
  entry: Record<string, unknown>,
  fallbackId: string
): ToolMessage | null {
  const toolCallId =
    (typeof entry["tool_call_id"] === "string" && entry["tool_call_id"]) ||
    (typeof entry["id"] === "string" ? entry["id"] : undefined) ||
    fallbackId;

  const parsedContent = parseToolMessageContent(entry["content"]);

  const textContent =
    parsedContent.outputs.length > 0
      ? parsedContent.outputs.join("\n\n")
      : typeof entry["content"] === "string"
      ? entry["content"]
      : JSON.stringify(entry["content"] ?? "");

  return new ToolMessage({
    id: typeof entry["id"] === "string" ? entry["id"] : fallbackId,
    content: textContent,
    tool_call_id: toolCallId,
    name: typeof entry["name"] === "string" ? entry["name"] : undefined,
    artifact: parsedContent.artifact ?? entry["artifact"],
    status:
      entry["status"] === "success" || entry["status"] === "error"
        ? (entry["status"] as "success" | "error")
        : undefined,
  });
}

/**
 * Normalizes AI message content coming from stored data.
 *
 * @param rawContent - Content field from data part
 * @param fallback - Fallback text content
 * @returns Content suitable for AIMessage
 */
function normalizeAIContent(
  rawContent: unknown,
  fallback: string
): string | MessageContent {
  if (typeof rawContent === "string") {
    return rawContent;
  }

  if (Array.isArray(rawContent)) {
    return rawContent as MessageContent;
  }

  if (rawContent === undefined || rawContent === null) {
    return fallback;
  }

  if (typeof rawContent === "object") {
    return rawContent as MessageContent;
  }

  return String(rawContent);
}

/**
 * Parses a tool message content payload, extracting readable outputs and retaining artifacts.
 *
 * @param rawContent - Content field from tool message entry
 * @returns Parsed outputs and artifact
 */
function parseToolMessageContent(
  rawContent: unknown
): { outputs: string[]; artifact?: unknown } {
  if (typeof rawContent !== "string") {
    return {
      outputs: [],
      artifact: rawContent,
    };
  }

  const trimmed = rawContent.trim();

  if (!trimmed) {
    return { outputs: [], artifact: undefined };
  }

  try {
    const parsed = JSON.parse(trimmed);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const outputs: string[] = [];

    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as Record<string, unknown>;
      const functionResponse = record["functionResponse"];

      if (
        functionResponse &&
        typeof functionResponse === "object" &&
        functionResponse !== null
      ) {
        const response = (functionResponse as Record<string, unknown>)["response"];

        const text = extractToolResponseText(response);
        if (text) {
          outputs.push(text);
        }
      }
    }

    return {
      outputs: outputs.length > 0 ? outputs : [trimmed],
      artifact: parsed,
    };
  } catch (_error) {
    return { outputs: [rawContent], artifact: rawContent };
  }
}

/**
 * Normalizes tool calls from stored data.
 *
 * @param raw - Raw tool_calls field
 * @param additional - additional_kwargs that may include tool call info
 * @returns Array of LangChain tool calls or undefined
 */
function normalizeToolCalls(
  raw: unknown,
  additional: Record<string, unknown>
): LangChainToolCall[] | undefined {
  const fromToolCalls = parseToolCallsArray(raw);

  if (fromToolCalls.length > 0) {
    return fromToolCalls;
  }

  const additionalToolCalls = parseAdditionalToolCalls(additional);

  return additionalToolCalls.length > 0 ? additionalToolCalls : undefined;
}

/**
 * Parses tool call definitions from an array.
 *
 * @param raw - Potential array of tool calls
 * @returns Normalized tool calls
 */
function parseToolCallsArray(raw: unknown): LangChainToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const toolCalls: LangChainToolCall[] = [];

  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }

    const name =
      typeof item["name"] === "string" ? (item["name"] as string) : undefined;
    const args = coerceArgs(item["args"]);

    if (!name) {
      continue;
    }

    toolCalls.push({
      name,
      args,
      id:
        typeof item["id"] === "string"
          ? (item["id"] as string)
          : undefined,
      type: "tool_call" as const,
    });
  }

  return toolCalls;
}

/**
 * Parses tool call information from additional_kwargs.tool_calls array.
 *
 * @param additional - additional_kwargs object
 * @returns Normalized tool calls
 */
function parseAdditionalToolCalls(
  additional: Record<string, unknown>
): LangChainToolCall[] {
  const raw = additional["tool_calls"];

  if (!Array.isArray(raw)) {
    return [];
  }

  const toolCalls: LangChainToolCall[] = [];

  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }

    const fn = item["function"];

    if (!isRecord(fn)) {
      continue;
    }

    const name =
      typeof fn["name"] === "string" ? (fn["name"] as string) : undefined;
    const argsRaw = fn["arguments"];

    if (!name || typeof argsRaw !== "string") {
      continue;
    }

    toolCalls.push({
      id:
        typeof item["id"] === "string"
          ? (item["id"] as string)
          : undefined,
      name,
      args: coerceArgs(argsRaw),
      type: "tool_call" as const,
    });
  }

  return toolCalls;
}

/**
 * Normalizes invalid tool call entries.
 *
 * @param raw - Raw invalid_tool_calls field
 * @returns Array of invalid tool calls or undefined
 */
function normalizeInvalidToolCalls(
  raw: unknown
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const invalidCalls = raw.filter(isRecord).map((item) => ({
    ...item,
    type: "invalid_tool_call",
  }));

  return invalidCalls.length > 0 ? invalidCalls : undefined;
}

/**
 * Extracts text from a tool response payload.
 *
 * @param response - Tool response object
 * @returns Text representation if available
 */
function extractToolResponseText(response: unknown): string | undefined {
  if (response === undefined || response === null) {
    return undefined;
  }

  if (typeof response === "string") {
    return response;
  }

  if (typeof response === "object") {
    const responseRecord = response as Record<string, unknown>;

    if (typeof responseRecord["output"] === "string") {
      return responseRecord["output"];
    }

    if (typeof responseRecord["error"] === "string") {
      return responseRecord["error"];
    }
  }

  try {
    return JSON.stringify(response);
  } catch (_error) {
    return String(response);
  }
}

/**
 * Attempts to parse JSON, returning the original string on failure.
 *
 * @param value - JSON string to parse
 * @returns Parsed object or original string
 */
function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

/**
 * Coerces tool call arguments into an object.
 *
 * @param value - Raw argument value
 * @returns Object representation of arguments
 */
function coerceArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    return isRecord(parsed) ? parsed : {};
  }

  if (isRecord(value)) {
    return value;
  }

  return {};
}

/**
 * Type guard for plain object records.
 *
 * @param value - Value to test
 * @returns true if value is a non-null object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
