  服务端接收客户端工具定义并转发给 LLM
  的设计方案

## 📋 方案决策

  **最终选择：DataPart 方案（严格遵循 A2A
  标准）**

  基于以下考虑:
  - ✅ 严格遵循 A2A 协议标准
  - ✅ 实现简单,快速上线
  - ✅ 每次消息都传递工具定义,简化业务逻辑
  - ✅ 支持动态工具集,灵活性最高

  ---

  ## 🎯 技术方案概览

  ### 核心思路

  工具定义通过 A2A Message 的 `parts`
  字段传递,使用标准的 `DataPart` 类型:

  ```typescript
  Message.parts = [
    { kind: 'text', text: '用户消息内容' },
    { kind: 'data', data: { tools: [...] } }
   // ← 工具定义
  ]

  服务端从 parts 中提取工具定义,转换为
  LangChain 格式后绑定到 LLM。

  ---
  📐 数据格式定义

  工具定义格式 (LangChain 标准)

  interface ToolDefinition {
    type: "function";
    function: {
      name: string;              // 工具名称
  (必需)
      description: string;       // 工具描述
  (必需)
      parameters: {              // JSON
  Schema 格式 (必需)
        type: "object";
        properties: Record<string, {
          type: string;          // 参数类型:
   string, number, boolean, array, object
          description?: string;  // 参数描述
          enum?: string[];       // 枚举值
  (可选)
        }>;
        required?: string[];     //
  必需参数列表
      };
    };
  }

  示例工具定义

  const weatherTool: ToolDefinition = {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather
  information for a given location",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "The city and state,
   e.g. San Francisco, CA"
          },
          unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "The temperature
  unit to use"
          }
        },
        required: ["location"]
      }
    }
  };

  const readFileTool: ToolDefinition = {
    type: "function",
    function: {
      name: "read_file",
      description: "Read contents from a
  file",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to
  the file"
          },
          encoding: {
            type: "string",
            enum: ["utf-8", "ascii",
  "base64"],
            description: "File encoding"
          }
        },
        required: ["file_path"]
      }
    }
  };

  ---
  👨‍💻 客户端实现指南

  步骤 1: 构造带工具定义的消息

  import { A2AClient, Message } from
  "@a2a-js/sdk/client";

  // 1. 准备工具定义数组
  const availableTools: ToolDefinition[] = [
    weatherTool,
    readFileTool,
    // ... 更多工具
  ];

  // 2. 构造消息,在 parts 中添加 DataPart
  const messageWithTools: Message = {
    kind: "message",
    role: "user",
    parts: [
      // 用户的文本消息
      {
        kind: "text",
        text: "What's the weather in San
  Francisco? Also read /tmp/config.txt"
      },
      // 工具定义 DataPart
      {
        kind: "data",
        data: {
          tools: availableTools  //
  工具定义数组
        },
        metadata: {
          type: "tool-definitions",
          format: "langchain",
          count: availableTools.length
        }
      }
    ]
  };

  // 3. 发送消息
  const client = await A2AClient.fromCardUrl(
    "http://localhost:41242/.well-known/agent
  -card.json"
  );

  const response = await
  client.sendMessage(messageWithTools);

  步骤 2: 处理服务端返回的 Tool Calls

  服务端会在响应消息的 DataPart 中返回
  tool_calls:

  import { parseA2AMessageForLangChain } from
   "@a2a-llm-proxy-agent/converter";

  // 解析响应消息
  const parsed = parseA2AMessageForLangChain(
  response.message);

  if (parsed && parsed.toolCalls.length > 0)
  {
    console.log(`LLM 请求调用
  ${parsed.toolCalls.length} 个工具:`);

    // 处理每个工具调用
    for (const toolCall of parsed.toolCalls)
  {
      console.log(`- ${toolCall.name}(${JSON.
  stringify(toolCall.args)})`);

      // 在客户端执行工具
      const toolResult = await
  executeToolLocally(toolCall);

      // 将工具执行结果发送回服务端
      const toolResultMessage: Message = {
        kind: "message",
        role: "user",
        parts: [
          {
            kind: "text",
            text: `Tool "${toolCall.name}"
  returned: ${JSON.stringify(toolResult)}`
          },
          // 继续携带工具定义 (支持后续调用)
          {
            kind: "data",
            data: {
              tools: availableTools
            },
            metadata: {
              type: "tool-definitions",
              format: "langchain"
            }
          }
        ]
      };

      // 发送工具结果,获取 LLM 的最终响应
      const finalResponse = await
  client.sendMessage(toolResultMessage);
      console.log("Final answer:",
  finalResponse.message.parts[0].text);
    }
  }

  步骤 3: 本地工具执行示例

  /**
   * 客户端工具执行函数
   */
  async function executeToolLocally(toolCall:
   ToolCall): Promise<any> {
    const { name, args } = toolCall;

    switch (name) {
      case "get_weather":
        // 调用天气 API
        const weatherData = await fetch(
          `https://api.weather.com?location=$
  {args.location}&unit=${args.unit}`
        );
        return await weatherData.json();

      case "read_file":
        // 读取本地文件
        const fs = require("fs").promises;
        const content = await
  fs.readFile(args.file_path, args.encoding
  || "utf-8");
        return { content, size:
  content.length };

      case "search_database":
        // 查询数据库
        const results = await
  database.query(args.query);
        return results;

      default:
        throw new Error(`Unknown tool:
  ${name}`);
    }
  }

  步骤 4: 完整的客户端工作流

  /**
   * 完整的客户端 Agent 工作流
   */
  class A2AClientAgent {
    private client: A2AClient;
    private tools: ToolDefinition[];

    constructor(serverUrl: string, tools:
  ToolDefinition[]) {
      this.tools = tools;
      this.client = await
  A2AClient.fromCardUrl(serverUrl);
    }

    /**
     * 发送用户消息并处理工具调用循环
     */
    async sendMessageWithTools(userText:
  string): Promise<string> {
      let currentMessage =
  this.buildMessage(userText);
      let maxIterations = 5;  // 防止无限循环

      while (maxIterations-- > 0) {
        // 发送消息到服务端
        const response = await
  this.client.sendMessage(currentMessage);

        // 解析响应
        const parsed = parseA2AMessageForLang
  Chain(response.message);

        // 如果没有工具调用,返回文本响应
        if (!parsed ||
  parsed.toolCalls.length === 0) {
          return parsed?.content || "No
  response";
        }

        // 执行所有工具调用
        console.log(`Executing
  ${parsed.toolCalls.length} tool(s)...`);
        const toolResults = [];

        for (const toolCall of
  parsed.toolCalls) {
          try {
            const result = await
  executeToolLocally(toolCall);
            toolResults.push({
              name: toolCall.name,
              result: result
            });
          } catch (error) {
            toolResults.push({
              name: toolCall.name,
              error: error.message
            });
          }
        }

        // 构造工具结果消息
        currentMessage = this.buildMessage(
          `Tool results:
  ${JSON.stringify(toolResults)}`
        );
      }

      throw new Error("Max tool call
  iterations exceeded");
    }

    /**
     * 构造带工具定义的消息
     */
    private buildMessage(text: string):
  Message {
      return {
        kind: "message",
        role: "user",
        parts: [
          { kind: "text", text },
          {
            kind: "data",
            data: { tools: this.tools },
            metadata: {
              type: "tool-definitions",
              format: "langchain"
            }
          }
        ]
      };
    }
  }

  // 使用示例
  const agent = new A2AClientAgent(
    "http://localhost:41242/.well-known/agent
  -card.json",
    [weatherTool, readFileTool]
  );

  const answer = await
  agent.sendMessageWithTools(
    "What's the weather in SF and what's in
  /tmp/config.txt?"
  );
  console.log(answer);

  ---
  🔧 服务端实现

  文件 1: src/tools.ts (新增)

  /**
   * Tool definition utilities for A2A <->
  LangChain conversion
   */

  import type { Message, Part, DataPart }
  from "@a2a-js/sdk";

  // LangChain 工具定义格式
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
   * 从 A2A Message 的 parts 中提取工具定义
   *
   * @param message - A2A Message 对象
   * @returns 工具定义数组
  (如果没有则返回空数组)
   */
  export function
  extractToolsFromMessage(message: Message):
  LangChainToolDefinition[] {
    console.log("[ToolExtractor] Extracting
  tools from message...");

    // 遍历 parts 查找 DataPart
    for (const part of message.parts) {
      if (part.kind !== "data") continue;

      const dataPart = part as DataPart;

      // 检查 data 对象中是否包含 tools 字段
      if (
        dataPart.data &&
        typeof dataPart.data === "object" &&
        "tools" in dataPart.data &&
        Array.isArray(dataPart.data.tools)
      ) {
        const tools = dataPart.data.tools as
  LangChainToolDefinition[];

        // 验证工具格式
        if (validateTools(tools)) {
          console.log(
            `[ToolExtractor] ✅ Found
  ${tools.length} valid tools in DataPart`
          );
          return tools;
        } else {
          console.warn("[ToolExtractor] ⚠️
  Tools found but validation failed");
        }
      }
    }

    console.log("[ToolExtractor] ⚠️ No tools
  found in message");
    return [];
  }

  /**
   * 验证工具定义格式
   */
  function validateTools(tools: any[]):
  boolean {
    if (!Array.isArray(tools) || tools.length
   === 0) {
      return false;
    }

    // 验证每个工具的基本结构
    for (const tool of tools) {
      if (
        typeof tool !== "object" ||
        tool === null ||
        tool.type !== "function" ||
        typeof tool.function !== "object" ||
        typeof tool.function.name !==
  "string" ||
        typeof tool.function.description !==
  "string" ||
        typeof tool.function.parameters !==
  "object"
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * 将工具定义转换为 LangChain bind 格式
   */
  export function
  convertToolsForLangChain(tools:
  LangChainToolDefinition[]) {
    return tools.map(tool => ({
      type: "function" as const,
      function: {
        name: tool.function.name,
        description:
  tool.function.description,
        parameters: tool.function.parameters,
      },
    }));
  }

  文件 2: index.ts (修改)

  import { extractToolsFromMessage,
  convertToolsForLangChain } from
  "./src/tools.js";

  class LLMAgentExecutor implements
  AgentExecutor {
    // ... 现有代码 ...

    async execute(
      requestContext: RequestContext,
      eventBus: ExecutionEventBus
    ): Promise<void> {
      const userMessage =
  requestContext.userMessage;
      const taskId = requestContext.taskId;
      const contextId =
  requestContext.contextId;

      console.log(
        `[LLMAgentExecutor] Processing
  message ${userMessage.messageId}`
      );

      // ========== 提取工具定义 ==========
      const toolDefinitions =
  extractToolsFromMessage(userMessage);

      if (toolDefinitions.length > 0) {
        console.log(
          `[LLMAgentExecutor] 📦 Extracted
  ${toolDefinitions.length} tools:`,
          toolDefinitions.map(t =>
  t.function.name).join(", ")
        );
      }
      // =================================

      // ... Task 初始化和 status update 代码
   ...

      // 准备对话历史
      const historyForLLM =
  contexts.get(contextId) || [];
      historyForLLM.push(userMessage);
      contexts.set(contextId, historyForLLM);

      const langchainMessages =
  a2aMessagesToLangChain(historyForLLM);

      try {
        // ========== 动态绑定工具 ==========
        let llmToUse = this.llm;

        if (toolDefinitions.length > 0) {
          const langchainTools =
  convertToolsForLangChain(toolDefinitions);
          llmToUse = this.llm.bind({ tools:
  langchainTools });

          console.log(`[LLMAgentExecutor] 🔧
  Bound tools to LLM`);
        }
        // ==================================

        // 调用 LLM
        const stream = await
  llmToUse.stream(langchainMessages);

        // ... 流式处理代码 (保持不变) ...
      } catch (error) {
        // ... 错误处理 ...
      }
    }
  }

  ---
  📊 完整数据流

  ┌─────────┐
  ┌─────────┐                  ┌─────────┐
  │ Client  │
  │ Server  │                  │   LLM   │
  └────┬────┘
  └────┬────┘                  └────┬────┘
       │
       │                             │
       │ 1. sendMessage(text + tools in
  DataPart)│                             │
       ├─────────────────────────────────────
  ────>│                             │
       │
       │                             │
       │
       │ 2. Extract tools from parts │
       │
       ├─────────┐                   │
       │
       │         │                   │
       │
       │<────────┘                   │
       │
       │                             │
       │
       │ 3. Bind tools to LLM        │
       │
       ├─────────────────────────────>│
       │
       │                             │
       │
       │ 4. Return AIMessage         │
       │
       │    with tool_calls          │
       │
       │<─────────────────────────────┤
       │
       │                             │
       │ 5. A2A Message (含 tool_calls in
  DataPart)│                             │
       │<────────────────────────────────────
  ─────┤                             │
       │
       │                             │
       │ 6. Execute tools locally
       │                             │
       ├─────────┐
       │                             │
       │         │
       │                             │
       │<────────┘
       │                             │
       │
       │                             │
       │ 7. sendMessage(tool_results + tools)
       │                             │
       ├─────────────────────────────────────
  ────>│                             │
       │
       │                             │
       │
       │ 8. Bind tools again         │
       │
       ├─────────────────────────────>│
       │
       │                             │
       │
       │ 9. Final answer             │
       │
       │<─────────────────────────────┤
       │
       │                             │
       │ 10. A2A Message (final answer)
       │                             │
       │<────────────────────────────────────
  ─────┤                             │
       │
       │                             │

  ---
  ⚠️ 错误处理

  客户端错误处理

  try {
    const response = await
  client.sendMessage(messageWithTools);
    const parsed = parseA2AMessageForLangChai
  n(response.message);

    if (!parsed) {
      console.error("Failed to parse
  response");
      // 降级处理: 重试或使用默认响应
    }

    if (parsed.toolCalls.length > 0) {
      for (const toolCall of
  parsed.toolCalls) {
        try {
          const result = await
  executeToolLocally(toolCall);
          // ... 发送结果
        } catch (toolError) {
          console.error(`Tool
  ${toolCall.name} failed:`, toolError);
          // 将错误信息发送回服务端
          await client.sendMessage({
            kind: "message",
            role: "user",
            parts: [{
              kind: "text",
              text: `Tool ${toolCall.name}
  failed: ${toolError.message}`
            }]
          });
        }
      }
    }
  } catch (error) {
    console.error("Failed to send message:",
  error);
    // 网络错误处理
  }

  服务端错误处理

  工具提取失败时的降级策略已在
  extractToolsFromMessage 中实现:
  - 如果没有找到工具,返回空数组
  - LLM 将在没有工具的情况下运行
  - 日志会记录详细的提取过程

  ---
  ✅ 方案优势

  1. 严格遵循 A2A 标准 ⭐⭐⭐⭐⭐
    - 使用标准的 Message.parts 和 DataPart
    - 与其他 A2A 实现完全兼容
  2. 实现简单 ⭐⭐⭐⭐⭐
    - 客户端只需修改消息构造方式
    - 服务端只需新增 1 个文件 + 少量修改
    - 预计开发时间: 3-4 小时
  3. 高度灵活 ⭐⭐⭐⭐⭐
    - 每次消息可以有不同的工具集
    - 支持动态工具更新
    - 无需额外的注册机制
  4. 易于调试 ⭐⭐⭐⭐⭐
    - 工具定义在消息中可见
    - 详细的日志输出
    - 清晰的数据流

  ---
  🚀 实施计划

  第一阶段: 服务端实现 (2-3 小时)

  1. ✅ 创建 src/tools.ts 文件
  2. ✅ 实现工具提取和转换逻辑
  3. ✅ 修改 index.ts 的 execute 方法
  4. ✅ 添加日志和错误处理
  5. ✅ 本地测试工具提取

  第二阶段: 客户端实现 (2-3 小时)

  1. ✅ 修改消息构造,添加 DataPart
  2. ✅ 实现工具执行函数
  3. ✅ 实现工具调用循环逻辑
  4. ✅ 添加错误处理

  第三阶段: 联调测试 (1-2 小时)

  1. ✅ 测试单工具调用
  2. ✅ 测试多工具调用
  3. ✅ 测试工具调用链
  4. ✅ 测试错误场景
  5. ✅ 性能测试

  总计: 5-8 小时

  ---
  📝 验证清单

  部署前请确认:

  - 客户端能成功构造带 DataPart 的消息
  - 服务端能从 DataPart 提取工具定义
  - 服务端能成功绑定工具到 LLM
  - LLM 返回的 tool_calls 能被正确解析
  - 客户端能执行本地工具
  - 工具结果能正确发送回服务端
  - 多轮工具调用循环正常工作
  - 错误场景有合理的降级处理
  - 日志输出完整清晰

  ---
  🔮 未来扩展

  本方案为未来优化预留了空间:

  1. 工具缓存: 如需性能优化,可以添加工具 ID
  引用机制
  2. 工具权限: 可以在服务端添加工具白名单验证
  3. 工具监控: 可以添加工具调用统计和监控
  4. 混合模式:
  可以支持既有全局工具,也有临时工具

  这些都可以在不破坏现有实现的基础上逐步添加
  。

  ---
  📚 参考资料

  - https://github.com/google-a2a/A2A
  - https://js.langchain.com/docs/modules/age
  nts/tools/
  - https://platform.openai.com/docs/guides/f
  unction-calling

  这是更新后的完整设计文档。主要改进:

  1. ✅ **明确推荐 DataPart 方案**
  2. ✅ **详细的客户端实现指南** (4 个步骤 +
  完整示例)
  3. ✅ **完整的端到端数据流图**
  4. ✅ **错误处理指南**
  5. ✅ **实施计划和验证清单**
  6. ✅ **客户端工具执行示例**
  7. ✅ **完整的工作流封装类**