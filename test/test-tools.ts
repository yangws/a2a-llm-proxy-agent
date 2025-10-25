/**
 * Test script for tool definition extraction and conversion
 */

import { Message } from "@a2a-js/sdk";
import { extractToolsFromMessage, convertToolsForLangChain, LangChainToolDefinition } from "../src/tools.js";

// Sample tool definitions (following the design doc format)
const weatherTool: LangChainToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather information for a given location",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "The city and state, e.g. San Francisco, CA"
        },
        unit: {
          type: "string",
          enum: ["celsius", "fahrenheit"],
          description: "The temperature unit to use"
        }
      },
      required: ["location"]
    }
  }
};

const readFileTool: LangChainToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read contents from a file",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute path to the file"
        },
        encoding: {
          type: "string",
          enum: ["utf-8", "ascii", "base64"],
          description: "File encoding"
        }
      },
      required: ["file_path"]
    }
  }
};

// Test Case 1: Message with tool definitions
console.log("\n========== Test Case 1: Message with tool definitions ==========");

const messageWithTools: Message = {
  kind: "message",
  role: "user",
  messageId: "test-msg-001",
  parts: [
    {
      kind: "text",
      text: "What's the weather in San Francisco? Also read /tmp/config.txt"
    },
    {
      kind: "data",
      data: {
        tools: [weatherTool, readFileTool]
      },
      metadata: {
        type: "tool-definitions",
        format: "langchain",
        count: 2
      }
    }
  ]
};

const extractedTools1 = extractToolsFromMessage(messageWithTools);
console.log(`\nExtracted ${extractedTools1.length} tools:`);
extractedTools1.forEach((tool, index) => {
  console.log(`  ${index + 1}. ${tool.function.name}: ${tool.function.description}`);
});

if (extractedTools1.length > 0) {
  const converted1 = convertToolsForLangChain(extractedTools1);
  console.log("\nConverted tools for LangChain:");
  console.log(JSON.stringify(converted1, null, 2));
}

// Test Case 2: Message without tool definitions
console.log("\n\n========== Test Case 2: Message without tool definitions ==========");

const messageWithoutTools: Message = {
  kind: "message",
  role: "user",
  messageId: "test-msg-002",
  parts: [
    {
      kind: "text",
      text: "Hello, how are you?"
    }
  ]
};

const extractedTools2 = extractToolsFromMessage(messageWithoutTools);
console.log(`\nExtracted ${extractedTools2.length} tools (should be 0)`);

// Test Case 3: Message with invalid tool format
console.log("\n\n========== Test Case 3: Message with invalid tool format ==========");

const messageWithInvalidTools: Message = {
  kind: "message",
  role: "user",
  messageId: "test-msg-003",
  parts: [
    {
      kind: "text",
      text: "Test message"
    },
    {
      kind: "data",
      data: {
        tools: [
          {
            // Missing 'type' field
            function: {
              name: "invalid_tool"
            }
          }
        ]
      },
      metadata: {
        type: "tool-definitions"
      }
    }
  ]
};

const extractedTools3 = extractToolsFromMessage(messageWithInvalidTools);
console.log(`\nExtracted ${extractedTools3.length} tools (should be 0 due to validation failure)`);

// Test Case 4: Multiple DataParts (only first with tools should be extracted)
console.log("\n\n========== Test Case 4: Multiple DataParts ==========");

const messageWithMultipleDataParts: Message = {
  kind: "message",
  role: "user",
  messageId: "test-msg-004",
  parts: [
    {
      kind: "text",
      text: "Test message"
    },
    {
      kind: "data",
      data: {
        someOtherData: "value"
      }
    },
    {
      kind: "data",
      data: {
        tools: [weatherTool]
      },
      metadata: {
        type: "tool-definitions"
      }
    }
  ]
};

const extractedTools4 = extractToolsFromMessage(messageWithMultipleDataParts);
console.log(`\nExtracted ${extractedTools4.length} tool(s):`);
extractedTools4.forEach((tool, index) => {
  console.log(`  ${index + 1}. ${tool.function.name}`);
});

console.log("\n========== All tests completed ==========\n");
