# LLM Proxy Agent

一个基于 A2A (Agent-to-Agent) 协议的 LLM 代理服务器。此 agent 充当 Azure OpenAI GPT-4 的代理，将用户请求转发给 LLM 并返回响应。

## 功能特性

- **LLM 代理**: 作为 Azure OpenAI 的代理，转发用户消息并返回 LLM 响应
- **基于 LangChain**: 使用 LangChain.js 与 Azure OpenAI 集成
- **A2A 协议**: 完全实现 A2A 协议，支持任务生命周期管理
- **对话历史**: 维护会话上下文，支持多轮对话
- **任务取消**: 支持取消正在进行的任务
- **流式支持**: 支持 SSE 流式响应（通过 A2A 框架）
- **独立项目**: 完整的独立 Node.js 项目，可直接复制到其他目录运行

## 环境要求

- Node.js >= 18
- npm 或 yarn

## 环境变量

此项目需要以下环境变量来访问 Azure OpenAI：

```bash
AZURE_API_KEY=your-azure-openai-api-key
AZURE_API_BASE=https://your-resource-name.openai.azure.com/
AZURE_RESOURCE_NAME=your-resource-name
AZURE_API_VERSION=2024-02-15-preview
```

可以创建 `.env` 文件或在命令行中设置这些变量。

## 安装

```bash
# 安装依赖
npm install
```

## 使用方法

### 1. 开发模式（推荐）

使用 tsx 直接运行 TypeScript 文件：

```bash
npm start
```

或使用 watch 模式（文件改动自动重启）：

```bash
npm run dev
```

### 2. 编译后运行

先编译 TypeScript：

```bash
npm run build
```

然后运行编译后的文件：

```bash
node dist/index.js
```

## 测试

服务器启动后，可以通过以下方式测试：

### 1. 获取 Agent Card

```bash
curl http://localhost:41242/.well-known/agent-card.json
```

### 2. 发送消息（使用 A2A 客户端）

使用 A2A 客户端库发送消息：

```typescript
import { A2AClient } from "@a2a-js/sdk/client";

const client = await A2AClient.fromCardUrl(
  "http://localhost:41242/.well-known/agent-card.json"
);

const response = await client.sendMessage({
  kind: "message",
  role: "user",
  parts: [{ kind: "text", text: "What is the capital of France?" }],
});

console.log(response);
```

### 3. JSON-RPC 请求

也可以直接发送 JSON-RPC 请求：

```bash
curl -X POST http://localhost:41242/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "sendMessage",
    "params": {
      "message": {
        "kind": "message",
        "role": "user",
        "parts": [{"kind": "text", "text": "Hello, how are you?"}]
      }
    },
    "id": 1
  }'
```

## 架构说明

### 核心组件

1. **LLMAgentExecutor**:
   - 实现 `AgentExecutor` 接口
   - 使用 LangChain 的 `AzureChatOpenAI` 连接 Azure OpenAI
   - 处理消息历史和对话上下文
   - 管理任务状态和取消逻辑

2. **A2A 集成**:
   - 使用 `DefaultRequestHandler` 处理 A2A 请求
   - 使用 `InMemoryTaskStore` 存储任务状态
   - 使用 `A2AExpressApp` 提供 HTTP 接口

3. **对话管理**:
   - 使用 `Map` 存储每个上下文的消息历史
   - 自动转换 A2A 消息格式到 LangChain 消息格式

### 工作流程

1. 客户端发送消息到服务器
2. `DefaultRequestHandler` 创建 `RequestContext` 和事件总线
3. `LLMAgentExecutor.execute()` 被调用：
   - 发布 "submitted" 状态
   - 发布 "working" 状态
   - 准备对话历史并转换为 LangChain 格式
   - 调用 Azure OpenAI API
   - 发布 "completed" 状态和 LLM 响应
4. 响应通过 A2A 协议返回给客户端

## 项目结构

```
llm-agent/
├── index.ts          # 主入口文件（包含 LLMAgentExecutor 和服务器设置）
├── package.json      # 项目依赖和脚本
├── tsconfig.json     # TypeScript 配置
├── .gitignore        # Git 忽略文件
└── README.md         # 本文件
```

## 依赖说明

### 核心依赖

- `@a2a-js/sdk`: A2A 协议 SDK
- `@langchain/core`: LangChain 核心库
- `@langchain/openai`: LangChain OpenAI 集成（包含 Azure OpenAI 支持）
- `express`: Web 服务器框架
- `uuid`: 生成唯一 ID

### 开发依赖

- `typescript`: TypeScript 编译器
- `tsx`: TypeScript 执行器
- `@types/*`: TypeScript 类型定义

## 配置说明

### 端口配置

默认端口为 `41242`，可通过环境变量 `PORT` 修改：

```bash
PORT=8080 npm start
```

### LLM 配置

在 `index.ts` 中可以调整 LLM 参数：

```typescript
this.llm = new AzureChatOpenAI({
  temperature: 0.7,        // 控制输出的随机性 (0-1)
  maxTokens: 2000,         // 最大生成 token 数
  // ... 其他配置
});
```

## 故障排除

### 问题：无法连接到 Azure OpenAI

- 检查环境变量是否正确设置
- 验证 API key 是否有效
- 确认 Azure 资源名称和部署名称正确

### 问题：依赖安装失败

- 确保 Node.js 版本 >= 18
- 尝试清除缓存：`npm cache clean --force`
- 删除 `node_modules` 和 `package-lock.json` 后重新安装

### 问题：TypeScript 编译错误

- 检查 `tsconfig.json` 配置
- 确保所有类型定义包都已安装
- 运行 `npm install` 确保依赖完整

## 许可证

此项目是 A2A JavaScript SDK 的一部分。

## 参考资料

- [A2A Protocol](https://github.com/google-a2a/A2A)
- [A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)
- [LangChain.js](https://js.langchain.com/)
- [Azure OpenAI](https://azure.microsoft.com/products/ai-services/openai-service)
