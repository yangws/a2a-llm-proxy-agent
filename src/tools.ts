/**
 * Tool definition utilities for A2A <-> LangChain conversion
 *
 * This module handles extraction and conversion of tool definitions
 * passed from clients via A2A DataPart to LangChain format.
 */

import type { Message, DataPart } from "@a2a-js/sdk";

/**
 * LangChain tool definition format (OpenAI Function Calling format)
 */
export interface LangChainToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

/**
 * Extracts tool definitions from A2A Message's parts.
 *
 * Searches through message parts for a DataPart containing tool definitions.
 * Tool definitions should be in the format:
 * {
 *   kind: "data",
 *   data: { tools: [...] },
 *   metadata: { type: "tool-definitions", ... }
 * }
 *
 * @param message - A2A Message object
 * @returns Array of tool definitions (empty array if none found)
 */
export function extractToolsFromMessage(
  message: Message
): LangChainToolDefinition[] {
  console.log("[ToolExtractor] Extracting tools from message...");
  console.log(`[ToolExtractor] Message has ${message.parts.length} part(s)`);

  // Iterate through all parts to find DataPart with tools
  for (const part of message.parts) {
    if (part.kind !== "data") {
      console.log(`[ToolExtractor] Skipping part with kind: ${part.kind}`);
      continue;
    }

    const dataPart = part as DataPart;

    // Check if data object contains tools field
    if (
      dataPart.data &&
      typeof dataPart.data === "object" &&
      "tools" in dataPart.data &&
      Array.isArray(dataPart.data.tools)
    ) {
      const tools = dataPart.data.tools as LangChainToolDefinition[];

      console.log(
        `[ToolExtractor] Found potential tools array with ${tools.length} item(s)`
      );

      // Validate tool definitions
      if (validateTools(tools)) {
        console.log(
          `[ToolExtractor] ✅ Successfully extracted ${tools.length} valid tool(s):`
        );
        tools.forEach((tool, index) => {
          console.log(`[ToolExtractor]   ${index + 1}. ${tool.function.name}`);
        });
        return tools;
      } else {
        console.warn(
          "[ToolExtractor] ⚠️ Tools found but validation failed"
        );
      }
    }
  }

  console.log("[ToolExtractor] ⚠️ No tools found in message parts");
  return [];
}

/**
 * Validates tool definition format.
 *
 * Ensures each tool conforms to the LangChain/OpenAI Function Calling format.
 *
 * @param tools - Array of potential tool definitions
 * @returns true if all tools are valid, false otherwise
 */
function validateTools(tools: any[]): boolean {
  if (!Array.isArray(tools) || tools.length === 0) {
    console.log("[ToolValidator] Invalid: Not an array or empty");
    return false;
  }

  // Validate each tool's structure
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];

    // Check basic structure
    if (
      typeof tool !== "object" ||
      tool === null ||
      tool.type !== "function" ||
      typeof tool.function !== "object" ||
      typeof tool.function.name !== "string" ||
      typeof tool.function.description !== "string" ||
      typeof tool.function.parameters !== "object"
    ) {
      console.log(
        `[ToolValidator] Invalid tool at index ${i}:`,
        JSON.stringify(tool, null, 2)
      );
      return false;
    }

    // Validate parameters object
    const params = tool.function.parameters;
    if (
      params.type !== "object" ||
      typeof params.properties !== "object" ||
      params.properties === null
    ) {
      console.log(
        `[ToolValidator] Invalid parameters structure at index ${i}`
      );
      return false;
    }

    // Check required field if present
    if (
      params.required !== undefined &&
      !Array.isArray(params.required)
    ) {
      console.log(
        `[ToolValidator] Invalid required field at index ${i}`
      );
      return false;
    }
  }

  console.log(`[ToolValidator] ✅ All ${tools.length} tools validated successfully`);
  return true;
}

/**
 * Converts tool definitions to LangChain bind format.
 *
 * Transforms tool definitions into the format expected by LangChain's
 * ChatModel.bind({ tools: [...] }) method.
 *
 * @param tools - Array of LangChain tool definitions
 * @returns Array of tools ready for LangChain binding
 */
export function convertToolsForLangChain(
  tools: LangChainToolDefinition[]
) {
  console.log(`[ToolConverter] Converting ${tools.length} tool(s) for LangChain`);

  const converted = tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));

  console.log("[ToolConverter] ✅ Conversion complete");
  return converted;
}
